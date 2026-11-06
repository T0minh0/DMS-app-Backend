import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

type Input = {
  ip: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
};
export function clientIp(
  request: Input,
  secret?: string,
  now = Math.floor(Date.now() / 1000),
) {
  const ip = request.headers["x-dms-client-ip"],
    time = request.headers["x-dms-client-time"],
    sig = request.headers["x-dms-client-signature"];
  const path = request.url.split("?")[0];
  if (
    !secret ||
    secret.length < 32 ||
    request.method !== "POST" ||
    !["/auth/reset-password", "/auth/forgot-password"].includes(path) ||
    typeof ip !== "string" ||
    typeof time !== "string" ||
    typeof sig !== "string" ||
    !/^\d{10}$/.test(time) ||
    Math.abs(now - Number(time)) > 60 ||
    !/^[a-f0-9]{64}$/.test(sig)
  )
    return request.ip;
  const kind = isIP(ip);
  if (!kind) return request.ip;
  let canonical = ip;
  if (kind === 6) {
    try {
      canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    } catch {
      return request.ip;
    }
  }
  if (ip !== canonical) return request.ip;
  const expected = createHmac("sha256", secret)
    .update(`${time}\n${request.method}\n${path}\n${canonical}`)
    .digest();
  const supplied = Buffer.from(sig, "hex");
  return timingSafeEqual(expected, supplied) ? canonical : request.ip;
}
