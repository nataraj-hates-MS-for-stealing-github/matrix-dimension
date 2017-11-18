import { Component, ViewChildren } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { ApiService } from "../shared/api.service";
import { ScalarService } from "../shared/scalar.service";
import { ToasterService } from "angular2-toaster";
import { Integration } from "../shared/models/integration";
import { IntegrationService } from "../shared/integration.service";
import * as _ from "lodash";
import { WIDGET_DIM_CUSTOM, WIDGET_DIM_YOUTUBE, WIDGET_DIM_TWITCH, WIDGET_DIM_ETHERPAD } from "../shared/models/widget";
import { IntegrationComponent } from "../integration/integration.component";

@Component({
    selector: "my-riot",
    templateUrl: "./riot.component.html",
    styleUrls: ["./riot.component.scss"],
})
export class RiotComponent {
    @ViewChildren(IntegrationComponent) integrationComponents: Array<IntegrationComponent>;

    public error: string;
    public integrations: Integration[] = [];
    public loading = true;
    public roomId: string;
    public scalarToken: string;

    private requestedScreen: string = null;
    private requestedIntegration: string = null;

    constructor(private activatedRoute: ActivatedRoute,
                private api: ApiService,
                private scalar: ScalarService,
                private toaster: ToasterService) {
        let params: any = this.activatedRoute.snapshot.queryParams;

        this.requestedScreen = params.screen;
        this.requestedIntegration = params.integ_id;

        if (!params.scalar_token || !params.room_id) this.error = "Missing scalar token or room ID";
        else {
            this.roomId = params.room_id;
            this.scalarToken = params.scalar_token;

            this.api.checkScalarToken(params.scalar_token).then(isValid => {
                if (isValid) this.init();
                else this.error = "Invalid scalar token";
            }).catch(err => {
                this.error = "Unable to communicate with Dimension";
                console.error(err);
            });
        }
    }

    private init() {
        this.api.getIntegrations(this.roomId, this.scalarToken).then(integrations => {
            this.integrations = _.filter(integrations, i => IntegrationService.isSupported(i));
            let promises = integrations.map(b => this.updateIntegrationState(b));
            return Promise.all(promises);
        }).then(() => {
            this.loading = false;

            // HACK: We wait for the digest cycle so we actually have components to look at
            setTimeout(() => this.tryOpenConfigScreen(), 20);
        }).catch(err => {
            this.error = "Unable to communicate with Dimension";
            console.error(err);
        });
    }

    private tryOpenConfigScreen() {
        let type = null;
        let integrationType = null;
        if (!this.requestedScreen) return;
        if (this.requestedScreen === "type_" + WIDGET_DIM_CUSTOM) {
            type = "widget";
            integrationType = "customwidget";
        } else if (this.requestedScreen === "type_" + WIDGET_DIM_YOUTUBE) {
            type = "widget";
            integrationType = "youtube";
        } else if (this.requestedScreen === "type_" + WIDGET_DIM_TWITCH) {
            type = "widget";
            integrationType = "twitch";
        } else if (this.requestedScreen === "type_" + WIDGET_DIM_ETHERPAD) {
            type = "widget";
            integrationType = "etherpad";
        } else {
            console.log("Unknown screen requested: " + this.requestedScreen);
        }

        let opened = false;
        this.integrationComponents.forEach(component => {
            if (opened) return;
            if (component.integration.type !== type || component.integration.integrationType !== integrationType) return;
            console.log("Configuring integration " + this.requestedIntegration + " type=" + type + " integrationType=" + integrationType);
            component.configureIntegration(this.requestedIntegration);
            opened = true;
        });
        if (!opened) {
            console.log("Failed to find integration component for type=" + type + " integrationType=" + integrationType);
        }
    }

    private updateIntegrationState(integration: Integration) {
        integration.hasConfig = IntegrationService.hasConfig(integration);

        if (integration.type === "widget") {
            integration.isEnabled = true;
            integration.isBroken = false;
            return Promise.resolve();
        }

        if (integration.requirements) {
            let keys = _.keys(integration.requirements);
            let promises = [];

            for (let key of keys) {
                let requirement = this.checkRequirement(integration, key);
                promises.push(requirement);
            }

            return Promise.all(promises).then(() => {
                integration.isEnabled = true;
                integration.isBroken = false;
            }, error => {
                console.error(error);
                integration.bridgeError = error.message || error;
                integration.isEnabled = false;
                integration.isBroken = false;
            });
        }

        return this.scalar.getMembershipState(this.roomId, integration.userId).then(payload => {
            integration.isBroken = false;

            if (!payload.response) {
                integration.isEnabled = false;
                return;
            }

            integration.isEnabled = (payload.response.membership === "join" || payload.response.membership === "invite");
        }, (error) => {
            console.error(error);
            integration.isEnabled = false;
            integration.isBroken = true;
        });
    }

    private checkRequirement(integration: Integration, key: string) {
        let requirement = integration.requirements[key];

        switch (key) {
            case "joinRule":
                return this.scalar.getJoinRule(this.roomId).then(payload => {
                    if (!payload.response) {
                        return Promise.reject("Could not communicate with Riot");
                    }
                    return payload.response.join_rule === requirement
                        ? Promise.resolve()
                        : Promise.reject(new Error("The room must be " + requirement + " to use this integration."));
                });
            default:
                return Promise.reject(new Error("Requirement '" + key + "' not found"));
        }
    }

    public updateIntegration(integration: Integration) {
        let promise = null;

        if (!integration.isEnabled) {
            promise = this.api.removeIntegration(this.roomId, integration.type, integration.integrationType, this.scalarToken);
        } else promise = this.scalar.inviteUser(this.roomId, integration.userId);

        promise.then(() => {
            if (integration.isEnabled)
                this.toaster.pop("success", integration.name + " was invited to the room");
            else this.toaster.pop("success", integration.name + " was removed from the room");
        }).catch(err => {
            let errorMessage = "Could not update integration status";

            if (err.json) {
                errorMessage = err.json().error;
            } else errorMessage = err.response.error.message;

            integration.isEnabled = !integration.isEnabled;
            this.toaster.pop("error", errorMessage);
        });
    }
}
