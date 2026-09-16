import { getAllowedFeatures } from "./capabilities";
import type { FeatureId } from "./features";
import type { ActorContext } from "./types";

// The only authorization data ever sent to the client: a flat list of
// feature ids safe for presentation (nav filtering, "what can I even
// try"). This DTO is never trusted for enforcement - every protected
// route independently re-checks canAccessFeature server-side on every
// request (see proxy.ts). Losing or tampering with this response can at
// worst show/hide the wrong nav items; it cannot grant access to anything.
export type ActorClientDto = {
  authenticated: true;
  role: string;
  displayName: string;
  activeFeatures: FeatureId[];
};

export async function toClientDto(actor: ActorContext): Promise<ActorClientDto> {
  const activeFeatures = await getAllowedFeatures(actor);
  return {
    authenticated: true,
    role: actor.role,
    displayName: actor.displayName,
    activeFeatures,
  };
}
