import {AudioPlayer} from "./AudioPlayer";
import {InteractionModel} from "./InteractionModel";
import {ModuleInvoker} from "./ModuleInvoker";
import {SkillContext} from "./SkillContext";
import {SessionEndedReason, SkillRequest} from "./SkillRequest";
import {Utterance} from "./Utterance";

type AlexaResponseCallback = (error: any, response: any, request: any) => void;

export enum AlexaEvent {
    SessionEnded,
    SkillError,
    SkillResponse,
}

export class SkillInteractor {
    private skillContext: SkillContext = null;

    public constructor(private handler: string, private model: InteractionModel, applicationID?: string) {
        const audioPlayer = new AudioPlayer(this);
        this.skillContext = new SkillContext(this.model, audioPlayer, applicationID);
        this.skillContext.newSession();
    }

    public context(): SkillContext {
        return this.skillContext;
    }

    /**
     * Calls the skill with specified phrase
     * Hits the callback with the JSON payload from the response
     * @param utterance
     * @param callback
     */
    public spoken(utteranceString: string): Promise<any> {
        let utterance = new Utterance(this.interactionModel(), utteranceString);

        // If we don't match anything, we use the default utterance - simple algorithm for this
        if (!utterance.matched()) {
            const defaultPhrase = this.interactionModel().sampleUtterances.defaultUtterance();
            utterance = new Utterance(this.interactionModel(), defaultPhrase.phrase);
            console.warn("No intentName matches utterance: " + utterance
                + ". Using fallback utterance: " + defaultPhrase.phrase);
        }

        return this.callSkillWithIntent(utterance.intent(), utterance.toJSON());
    }

    public launched(): Promise<any> {
        const serviceRequest = new SkillRequest(this.skillContext);
        serviceRequest.launchRequest();
        return this.callSkill(serviceRequest);
    }

    public sessionEnded(sessionEndedReason: SessionEndedReason, errorData: any): Promise<any> {
        if (sessionEndedReason === SessionEndedReason.ERROR) {
            console.error("SessionEndedRequest:\n" + JSON.stringify(errorData, null, 2));
        }

        const serviceRequest = new SkillRequest(this.skillContext);
        // Convert to enum value and send request
        serviceRequest.sessionEndedRequest(sessionEndedReason, errorData);
        const promise = this.callSkill(serviceRequest);

        // We do not wait for a reply - the session ends right away
        this.context().endSession();
        return promise;
    }

    /**
     * Passes in an intent with slots as a simple JSON map: {slot1: "value", slot2: "value2", etc.}
     * @param intentName
     * @param slots
     * @param callback
     */
    public intended(intentName: string, slots?: any): Promise<any> {
        return this.callSkillWithIntent(intentName, slots);
    }

    public callSkill(serviceRequest: SkillRequest): Promise<any> {
        // Call this at the last possible minute, because of state issues
        //  What can happen is this gets queued, and then another request ends the session
        //  So we want to wait until just before we send this to create the session
        // This ensures it is in the proper state for the duration
        if (serviceRequest.requiresSession() && !this.context().activeSession()) {
            this.context().newSession();
        }

        const requestJSON = serviceRequest.toJSON();
        console.log("CALLING: " + requestJSON.request.type);

        return ModuleInvoker.invoke(this.handler, requestJSON).then((result) => {
            // After a call, set the session to used (no longer new)
            if (this.context().activeSession()) {
                this.context().session().used();
                if (result && result.shouldEndSession) {
                    this.context().endSession();
                } else {
                    this.context().session().updateAttributes(result.sessionAttributes);
                }
            }
        });
    }

    private callSkillWithIntent(intentName: string, slots?: any): Promise<any> {
        // When the user utters an intent, we suspend for it
        // We do this first to make sure everything is in the right state for what comes next
        if (this.skillContext.audioPlayerEnabled() && this.skillContext.audioPlayer().isPlaying()) {
            this.skillContext.audioPlayer().suspend();
        }

        // Now we generate the service request
        //  The request is built based on the state from the previous step, so important that it is suspended first
        const serviceRequest = new SkillRequest(this.skillContext).intentRequest(intentName);
        if (slots !== undefined && slots !== null) {
            for (const slotName of Object.keys(slots)) {
                serviceRequest.withSlot(slotName, slots[slotName]);
            }
        }

        return this.callSkill(serviceRequest);
    }

    // Helper method for getting interaction model
    private interactionModel(): InteractionModel {
        return this.context().interactionModel();
    }
}