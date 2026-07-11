import { Injectable, ServiceUnavailableException } from "@nestjs/common";

export interface VerifiedAdminIdentity {
  lookupHash: string;
  mfa: boolean;
}

@Injectable()
export abstract class AdminIdentityVerifier {
  abstract verify(token: string): Promise<VerifiedAdminIdentity>;
}

@Injectable()
export class DisabledAdminIdentityVerifier extends AdminIdentityVerifier {
  async verify(token: string): Promise<VerifiedAdminIdentity> {
    void token;
    throw new ServiceUnavailableException("Administrator identity is not configured");
  }
}
