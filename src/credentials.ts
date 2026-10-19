import { Entry } from "@napi-rs/keyring";
import type { Profile } from "./config.js";

// 凭据绑定环境及服务器，编辑目标后不会误用旧服务器密码。
// 用同步 Entry 而非 AsyncEntry：后者的 AbortSignal 封装在 Bun 下不可用。
function entry(profile: Profile): Entry {
  return new Entry("code-deploy", `${profile.id}:${profile.user}@${profile.host}:${profile.port}`);
}

export async function savePassword(profile: Profile, password: string): Promise<void> {
  if (!password) throw new Error("密码不能为空");
  await entry(profile).setPassword(password);
}

export async function deletePassword(profile: Profile): Promise<void> {
  await entry(profile).deletePassword();
}

// 密码仅传给 SSH 子进程，不写配置、命令行参数或日志。
// password 字段是例外：用户明确写入配置文件的明文密码，本地存储，优先生效。
export async function resolvePassword(profile: Profile): Promise<string | undefined> {
  if (profile.password) return profile.password;
  if (profile.auth === "ssh") return undefined;
  const password = profile.auth === "env" ? process.env[profile.passwordEnv] : await entry(profile).getPassword();
  if (!password) throw new Error(profile.auth === "env"
    ? `请设置环境变量 ${profile.passwordEnv}，或在环境设置中改用钥匙串密码`
    : "钥匙串中没有此环境的密码，请在环境设置中保存");
  return password;
}
