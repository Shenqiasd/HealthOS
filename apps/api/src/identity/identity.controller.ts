import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type {
  AuthenticationResponse,
  DeviceRegistrationResponse,
  LogoutResponse,
  NonceResponse,
  SessionTokensResponse,
} from "@healthos/contracts";
import { CORRELATION_ID_HEADER } from "@healthos/observability";

import { AccessTokenGuard, type AuthenticatedRequest } from "./access-token.guard";
import { DeviceService } from "./device.service";
// DTO values are required at runtime for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AppleLoginDto } from "./dto/apple-login.dto";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RefreshTokenDto } from "./dto/refresh-token.dto";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RegisterDeviceDto } from "./dto/register-device.dto";
import { IdentityService } from "./identity.service";
import { SessionService } from "./session.service";

function correlationId(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "missing";
  return value ?? "missing";
}

@Controller("identity")
export class IdentityController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(DeviceService) private readonly devices: DeviceService,
  ) {}

  @Post("apple/nonce")
  @HttpCode(HttpStatus.OK)
  async issueNonce(): Promise<NonceResponse> {
    const nonce = await this.identity.issueNonce();
    return { nonce: nonce.value, expires_at: nonce.expiresAt.toISOString() };
  }

  @Post("apple")
  @HttpCode(HttpStatus.OK)
  async authenticate(
    @Body() dto: AppleLoginDto,
    @Headers(CORRELATION_ID_HEADER) requestCorrelationId: string | string[] | undefined,
  ): Promise<AuthenticationResponse> {
    const result = await this.identity.authenticateWithApple({
      identityToken: dto.identity_token,
      nonce: dto.nonce,
      correlationId: correlationId(requestCorrelationId),
    });
    return {
      user_id: result.userId,
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
    };
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Headers(CORRELATION_ID_HEADER) requestCorrelationId: string | string[] | undefined,
  ): Promise<SessionTokensResponse> {
    const tokens = await this.sessions.rotate(
      dto.refresh_token,
      correlationId(requestCorrelationId),
    );
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() dto: RefreshTokenDto,
    @Headers(CORRELATION_ID_HEADER) requestCorrelationId: string | string[] | undefined,
  ): Promise<LogoutResponse> {
    await this.sessions.revoke(
      dto.refresh_token,
      correlationId(requestCorrelationId),
    );
    return { status: "revoked" };
  }

  @Post("devices")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async registerDevice(
    @Req() request: AuthenticatedRequest,
    @Body() dto: RegisterDeviceDto,
  ): Promise<DeviceRegistrationResponse> {
    const principal = request.healthosPrincipal;
    if (!principal) throw new UnauthorizedException("Missing authenticated user");
    const device = await this.devices.register(principal.userId, {
      deviceId: dto.device_id,
      appVersion: dto.app_version,
      ...(dto.apns_token ? { apnsToken: dto.apns_token } : {}),
    });
    return {
      id: device.id,
      device_id: device.deviceId,
      app_version: device.appVersion,
    };
  }
}
