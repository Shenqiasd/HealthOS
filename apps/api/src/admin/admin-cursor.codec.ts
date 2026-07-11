import { createHmac, timingSafeEqual } from "node:crypto";
import { BadRequestException } from "@nestjs/common";

export interface AdminQueueCursor {
  snapshot_id: string;
  next_position: number;
  actor_id: string;
  queue_kind: "review" | "safety";
  status_filter: string;
  expires_at: string;
}

export class AdminCursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error("Admin cursor signing secret must contain at least 32 characters");
  }

  encode(cursor: AdminQueueCursor): string {
    const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
    return `${payload}.${this.signature(payload)}`;
  }

  decode(value: string): AdminQueueCursor {
    const [payload, suppliedSignature, extra] = value.split(".");
    if (!payload || !suppliedSignature || extra) throw new BadRequestException("Invalid queue cursor");
    const expectedSignature = this.signature(payload);
    const supplied = Buffer.from(suppliedSignature, "base64url");
    const expected = Buffer.from(expectedSignature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new BadRequestException("Invalid queue cursor signature");
    }
    try {
      const cursor = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<AdminQueueCursor>;
      if (
        typeof cursor.snapshot_id !== "string" || !/^[0-9a-f-]{36}$/.test(cursor.snapshot_id)
        || !Number.isInteger(cursor.next_position) || Number(cursor.next_position) < 1
        || typeof cursor.actor_id !== "string" || !/^[0-9a-f-]{36}$/.test(cursor.actor_id)
        || !["review", "safety"].includes(cursor.queue_kind ?? "")
        || typeof cursor.status_filter !== "string"
        || typeof cursor.expires_at !== "string" || Number.isNaN(Date.parse(cursor.expires_at))
      ) throw new Error("invalid");
      return cursor as AdminQueueCursor;
    } catch {
      throw new BadRequestException("Invalid queue cursor payload");
    }
  }

  private signature(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}
