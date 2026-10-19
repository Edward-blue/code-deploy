import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// 配置文件独立于项目，切换工作目录不会改变环境列表。
export const configFile = process.env.CODE_DEPLOY_CONFIG || path.join(homedir(), ".config/code-deploy/config.json");
const singleLine = z.string().refine(value => !/[\x00-\x1f\x7f]/.test(value), "不能包含控制字符");

// 拒绝根目录、系统目录及带跳转的路径，降低误覆盖风险。
export function isSafeRemoteDir(value: string): boolean {
  const parts = value.split("/").filter(Boolean);
  return value.startsWith("/") && parts.length >= 2 &&
    !/[\x00-\x1f\x7f]/.test(value) && !parts.some(part => part === "." || part === "..") &&
    !["bin", "sbin", "etc", "usr", "lib", "lib64", "proc", "sys", "dev", "boot", "run"].includes(parts[0]!);
}

const mappingSchema = z.object({
  projectDir: singleLine.refine(path.isAbsolute), branch: singleLine.min(1),
  host: singleLine.min(1), user: singleLine.min(1), port: z.number().int().min(1).max(65535),
  remoteDir: z.string().refine(isSafeRemoteDir)
});

export const profileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "环境标识只能使用小写字母、数字和连字符"),
  name: singleLine.min(1, "请输入环境名称"),
  projectDir: singleLine.refine(path.isAbsolute, "本地目录必须是绝对路径"),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, "请输入 IP、主机名或 SSH 别名"),
  user: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/, "请输入服务器账号"),
  port: z.number().int().min(1).max(65535),
  remoteDir: z.string().refine(isSafeRemoteDir, "远程目录必须是至少两级的绝对路径，且不能是系统目录"),
  buildCommand: singleLine,
  outputDir: singleLine.min(1).refine(value => !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."), "发布内容必须是源目录内的相对路径，或使用 . 发布源目录本身"),
  expectedBranch: singleLine,
  auth: z.enum(["env", "keychain", "ssh"]),
  passwordEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "环境变量名称无效"),
  password: singleLine.optional(),
  lockDirectory: z.boolean().default(false),
  lockBranch: z.boolean().default(false),
  lockMapping: z.boolean().default(false),
  checkGit: z.boolean().default(true),
  mapping: mappingSchema.optional()
});

export type Profile = z.infer<typeof profileSchema>;
const configSchema = z.object({ version: z.literal(1), profiles: z.array(profileSchema) }).superRefine((data, context) => {
  if (new Set(data.profiles.map(profile => profile.id)).size !== data.profiles.length) {
    context.addIssue({ code: "custom", message: "环境标识不能重复", path: ["profiles"] });
  }
  for (const profile of data.profiles) {
    if (profile.lockBranch && !profile.expectedBranch) context.addIssue({ code: "custom", message: `${profile.name}：开启分支锁时必须填写指定分支` });
    if (!profile.lockMapping) continue;
    const mapping = profile.mapping;
    if (!mapping || path.resolve(profile.projectDir) !== path.resolve(mapping.projectDir) ||
      targetKey(profile) !== targetKey(mapping)) {
      context.addIssue({ code: "custom", message: `${profile.name}：配置与锁定映射不一致，请先解除映射锁再修改` });
    }
    for (const other of data.profiles) {
      if (other.id === profile.id || !other.lockMapping || !other.mapping || !mapping) continue;
      const sameSource = path.resolve(mapping.projectDir) === path.resolve(other.mapping.projectDir);
      const sameTarget = targetKey(mapping) === targetKey(other.mapping);
      if (sameSource !== sameTarget) context.addIssue({ code: "custom", message: `${profile.name} 与 ${other.name} 的锁定映射不是一一对应` });
    }
  }
});
export type Config = z.infer<typeof configSchema>;

// 服务器和目录共同标识远程目标，规范化末尾斜线。
export function targetKey(target: Pick<Profile, "host" | "user" | "port" | "remoteDir">): string {
  return JSON.stringify([target.host, target.user, target.port, path.posix.normalize(target.remoteDir).replace(/\/$/, "")]);
}

// 旧配置曾固定从 projectDir 构建，迁移时显式保留这一约束。
function migrateConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("profiles" in value) || !Array.isArray(value.profiles)) return value;
  return { ...value, profiles: value.profiles.map(profile => ({
    ...profile,
    lockDirectory: profile.lockDirectory ?? true,
    lockBranch: profile.lockBranch ?? Boolean(profile.expectedBranch)
  })) };
}

// 只将“文件不存在”视为空配置，避免损坏配置被悄悄覆盖。
export async function loadConfig(file = configFile): Promise<Config> {
  try {
    return configSchema.parse(migrateConfig(JSON.parse(await readFile(file, "utf8"))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: [] };
    throw new Error(`读取配置失败 ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveConfig(config: Config, file = configFile): Promise<void> {
  const parsed = configSchema.parse(config);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

// 新配置使用通用默认值，服务器、目录和分支均由用户填写。
export function newProfile(): Profile {
  return {
    id: "", name: "", projectDir: process.cwd(), host: "", user: process.env.USER || "deploy", port: 22,
    remoteDir: "", buildCommand: "", outputDir: ".",
    expectedBranch: "", auth: "ssh", passwordEnv: "DEPLOY_SERVER_PASSWORD",
    lockDirectory: false, lockBranch: false, lockMapping: false, checkGit: true
  };
}
