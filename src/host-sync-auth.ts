import { invokeProtocolCommand as invoke } from "./tauri-protocol";

interface Login {
  accountId: string;
  token: string;
}

type AuthAction =
  | "login/start" | "login/finish"
  | "register/start" | "register/finish"
  | "upgrade/start" | "upgrade/finish"
  | "recovery/request" | "recovery/start" | "recovery/finish";

function accountRequest<T>(server: string, action: AuthAction, body: object) {
  return invoke<T>("host_sync_auth", { server, action, body });
}

interface Credentials {
  server: string;
  email: string;
  password: string;
  publicKey: string;
  deviceName?: string;
}

function checkPublicKey(expected: string, received: string) {
  if (!expected || expected !== received) throw new Error("同步服务器认证公钥不匹配");
}

function checkPassword(password: string) {
  if (password.length < 12 || new TextEncoder().encode(password).length > 1024) {
    throw new Error("账号密码至少需要 12 个字符，最多 1024 字节");
  }
}

export async function authenticateOpaque({ server, email, password, publicKey, deviceName }: Credentials) {
  checkPassword(password);
  const opaque = await import("@serenity-kit/opaque");
  await opaque.ready;
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });
  const { exchange, loginResponse } = await accountRequest<{ exchange: string; loginResponse: string }>(
    server, "login/start", { email, startLoginRequest },
  );
  const result = opaque.client.finishLogin({ clientLoginState, loginResponse, password });
  if (!result) throw new Error("账号或密码不正确。旧账号需先迁移。");
  checkPublicKey(publicKey, result.serverStaticPublicKey);
  return accountRequest<Login>(server, "login/finish", { exchange, deviceName, finishLoginRequest: result.finishLoginRequest });
}

type Enrollment =
  | { flow: "register"; accountId: string; vault: object; proof?: { inviteCode: string; verificationCode: string } }
  | { flow: "upgrade" }
  | { flow: "recovery"; code: string };

export async function enrollOpaque<T>(credentials: Credentials, enrollment: Enrollment) {
  const { server, email, password, publicKey, deviceName } = credentials;
  checkPassword(password);
  const opaque = await import("@serenity-kit/opaque");
  await opaque.ready;
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
  const startBody = {
    email, registrationRequest,
    ...(enrollment.flow === "register" ? enrollment.proof : {}),
    ...(enrollment.flow === "upgrade" ? { password } : {}),
    ...(enrollment.flow === "recovery" ? { code: enrollment.code } : {}),
  };
  const { exchange, registrationResponse } = await accountRequest<{ exchange: string; registrationResponse: string }>(
    server, `${enrollment.flow}/start`, startBody,
  );
  const result = opaque.client.finishRegistration({ clientRegistrationState, registrationResponse, password });
  checkPublicKey(publicKey, result.serverStaticPublicKey);
  return accountRequest<T>(server, `${enrollment.flow}/finish`, {
    exchange, deviceName, registrationRecord: result.registrationRecord,
    ...(enrollment.flow === "register" ? { accountId: enrollment.accountId, vault: enrollment.vault } : {}),
  });
}

export function requestPasswordRecovery(server: string, email: string) {
  return accountRequest<object>(server, "recovery/request", { email });
}
