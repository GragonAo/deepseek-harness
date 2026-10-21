/**
 * 对象存储后端与 `object_publish` 工具。
 *
 * 模型在沙箱里交付不了任何东西：沙箱是容器，用户只通过业务前端访问该部署。本插件把模型生成的
 * 文件写进部署方配置的 S3 兼容存储（Ceph RGW、MinIO、云对象存储都行），返回一条**匿名可下载**
 * 的公开地址；用户的浏览器、业务前端的下载按钮、外部系统都直接取这条地址，不再经过沙箱，也不再
 * 经过本服务。
 *
 * 公开性由桶策略给出（部署步骤），不由本服务给：写完之后会匿名 HEAD 一次自己的地址，确认这条
 * 地址真的能被没有凭据的客户端取到；取不到就报错，而不是把一条死链交给模型。
 *
 * 发布被部署方所鉴权的两项请求权威限定两次：**案件**（`requireTenant()`）与**主体**
 * （`requireUser()`）。一次调用只从调用主体的挂载读取，键里带案件与主体身份，因此一个主体既发布
 * 不了、也列举不到另一个主体的文件。
 * @module @deepseek-ai/dsh-object-store
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join, posix, resolve as resolveHost, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireTenant, requireUser } from '@deepseek-ai/dsh-tenant'
import { S3Client } from './s3.ts'
import type { S3Target } from './s3.ts'

/** Cordis 插件名。 */
export const name = 'object-store'

/** 工具注册表：工具在本插件里注册。 */
export const inject = ['tools']

/** 对象存储配置。除端点、桶与对外基址外都有默认值。 */
export interface Config {
  /** S3 端点源（`scheme://host[:port]`），服务访问存储用的那个地址。 */
  endpoint: string
  /** 桶名；该桶必须是部署侧已开放匿名只读的桶。 */
  bucket: string
  /** 对外下载基址（`scheme://host[:port]`），用户浏览器能到达的那个地址。 */
  publicBaseUrl: string
  /** 签名区域；RGW 默认 zonegroup 用 `us-east-1`。 */
  region?: string
  /** 读取访问密钥 ID 的环境变量名。 */
  accessKeyEnv?: string
  /** 读取秘密访问密钥的环境变量名。 */
  secretKeyEnv?: string
  /** 路径式寻址；RGW 与 MinIO 用 `true`。 */
  forcePathStyle?: boolean
  /** 对象键前缀，用来把本部署的对象与同一个桶里的其它对象分开。 */
  keyPrefix?: string
  /** 单个文件的上限字节数。 */
  maxBytes?: number
  /** `/global` 挂载对应的宿主根；该挂载不存在时省略。 */
  usersRoot?: string
  /** 写完之后匿名校验一次公开地址；确认「公开可下载」这件事真的成立。 */
  verifyPublic?: boolean
}

/**
 * 注册的工具名。业务前端从会话事件流里按这个名字取发布结果，用来渲染下载项，
 * 而不是去读模型正文。它是前后端之间的协议常量，因此不做成配置项：做成配置项，
 * 每个部署的名字就不同，前端无法只按一个名字取事件。
 */
const TOOL_NAME = 'object_publish'

/** 配置校验：必填项缺失、类型不对一律在启动前抛错。 */
export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  bucket: z.string().required(),
  publicBaseUrl: z.string().required(),
  region: z.string().default('us-east-1'),
  accessKeyEnv: z.string().default('DSH_OBJECT_ACCESS_KEY'),
  secretKeyEnv: z.string().default('DSH_OBJECT_SECRET_KEY'),
  forcePathStyle: z.boolean().default(true),
  keyPrefix: z.string().default(''),
  maxBytes: z.number().default(256 * 1024 * 1024),
  usersRoot: z.string(),
  verifyPublic: z.boolean().default(true),
})

/** 一次调用的按键解析后的策略。 */
interface Policy {
  readonly client: S3Client
  readonly bucket: string
  readonly publicBaseUrl: string
  readonly keyPrefix: string
  readonly maxBytes: number
  readonly usersRoot: string | undefined
  readonly verifyPublic: boolean
}

/** 扩展名到 `Content-Type` 的映射：浏览器据此决定内联打开还是直接下载。 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/**
 * 由扩展名推断 `Content-Type`。
 * @param fileName - 文件名（含扩展名）。
 * @returns 映射到的类型；未收录的扩展名按二进制流给出。
 */
export function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return CONTENT_TYPE_BY_EXTENSION[fileName.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

/** 一个沙箱挂载：模型这样称呼它，宿主这样存放它。 */
interface Mount {
  readonly container: string
  readonly host: string
}

/** 一次调用所属的案件与主体，以及由此确定的挂载。 */
interface Scope {
  readonly caseId: string
  readonly userId: string
  readonly mounts: readonly Mount[]
}

/**
 * 取出本次请求鉴权过的案件与主体。
 * @param policy - 已解析的部署策略。
 * @returns 调用作用域。
 * @throws 调用不在案件作用域内时。
 */
function currentScope(policy: Policy): Scope {
  const tenant = requireTenant()
  const user = String(requireUser())
  const mounts: Mount[] = [
    { container: '/workspace', host: resolveHost(tenant.workspaceRoot, 'users', user) },
    { container: '/case', host: resolveHost(tenant.workspaceRoot, 'work') },
  ]
  if (policy.usersRoot !== undefined) mounts.push({ container: '/global', host: resolveHost(policy.usersRoot, user) })
  return { caseId: segment(tenant.id), userId: segment(user), mounts }
}

/**
 * 把一个身份片段净化成能进对象键的 token。
 * @param value - 原始片段。
 * @returns 只含字母、数字、`.`、`_`、`-` 且非空的片段。
 */
function segment(value: string): string {
  const kept = [...value].filter(character => /[\p{L}\p{N}._-]/u.test(character)).join('')
  const trimmed = kept.replace(/^[._-]+|[._-]+$/g, '').slice(0, 80)
  return trimmed === '' ? 'item' : trimmed
}

/**
 * 把模型给的路径解析到调用主体的挂载之内。
 * @param scope - 调用作用域。
 * @param input - 模型给的路径，绝对或相对工作目录。
 * @param cwd - 会话的工作目录，用于相对路径。
 * @returns 挂载、模型看到的那条路径，以及真实宿主路径。
 * @throws 路径不在主体的挂载之内、不存在、不是普通文件时。
 */
async function resolveSource(scope: Scope, input: string, cwd: string): Promise<{ containerPath: string; host: string; size: number }> {
  const absolute = posix.isAbsolute(input) ? posix.normalize(input) : posix.resolve(cwd, input)
  const mount = scope.mounts.find((candidate) => {
    const root = posix.normalize(candidate.container)
    return absolute === root || absolute.startsWith(`${root}/`)
  })
  if (mount === undefined) {
    const readable = scope.mounts.map(candidate => candidate.container).join(', ')
    throw new Error(`file_path ${JSON.stringify(input)} is not inside the paths this subject can publish from (${readable})`)
  }
  const relative = absolute === posix.normalize(mount.container) ? '' : absolute.slice(posix.normalize(mount.container).length + 1)
  const candidate = join(mount.host, relative)
  const root = await fs.realpath(mount.host)
  let real: string
  try {
    real = await fs.realpath(candidate)
  } catch (error) {
    // `candidate` 是已解析过的挂载根拼上模型的路径，除「在不在」之外没有未知项：ENOENT 就是不在。
    // 其余错误码（EACCES、ELOOP、ENAMETOOLONG）说的是路径存在但读不了，报成「不存在」是把
    // 一个确定的失败换成一个具体而错误的结构。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error(`file_path ${JSON.stringify(absolute)} does not exist`)
  }
  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new Error(`file_path ${JSON.stringify(absolute)} resolves outside ${mount.container}`)
  }
  const info = await fs.stat(real)
  if (!info.isFile()) throw new Error(`file_path ${JSON.stringify(absolute)} is not a regular file`)
  return { containerPath: absolute, host: real, size: info.size }
}

/** 发布时刻的键前缀时间戳。 */
function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 拼出一个尚未占用的对象键：同名同秒的并发发布会各自得到自己的键。
 * @param policy - 已解析的策略。
 * @param scope - 调用作用域。
 * @param stem - 净化后的文件名主干。
 * @param extension - 含前导点的扩展名，可为空串。
 * @param signal - 取消信号。
 * @returns 可写入的对象键。
 * @throws 连续 20 个候选键都已被占用时。
 */
async function allocateKey(policy: Policy, scope: Scope, stem: string, extension: string, signal: AbortSignal): Promise<string> {
  const base = `${policy.keyPrefix}${scope.caseId}/${scope.userId}/${stamp(new Date())}_${stem}`
  for (let attempt = 1; attempt <= 20; attempt++) {
    const key = `${base}${attempt === 1 ? '' : `_${attempt}`}${extension}`
    if (await policy.client.headObject(key, signal) === undefined) return key
  }
  // 20 个候选都被占用说明同一主体在同一秒里发布了 20 次同名文件：再加随机段继续试，键会变长
  // 但发布仍然成功，比在这里失败更符合调用方的预期。
  return `${base}_${randomUUID().slice(0, 8)}${extension}`
}

const PUBLISH_DESCRIPTION =
  'Publish a file you generated to object storage and get back a public URL the user can download. '
  + 'Files inside your sandbox are unreachable by the user: this tool uploads the file to the deployment\'s '
  + 'object store and returns an absolute address that needs no credentials. Give that address to the user '
  + 'in your reply. Use it for reports, exports, spreadsheets, HTML summaries and archives. The uploaded '
  + 'object is immutable: publishing again uploads a new object, and the source stays in your workspace.'

/**
 * 注册对象存储后端与发布工具。
 * @param ctx - 承载工具注册表的上下文。
 * @param config - 部署的对象存储配置。
 * @throws 读取密钥的环境变量缺失时；此时服务起不来，而不是等到第一次发布才失败。
 */
export function apply(ctx: Context, config: Config): void {
  const target: S3Target = {
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region ?? 'us-east-1',
    accessKey: secret(config.accessKeyEnv ?? 'DSH_OBJECT_ACCESS_KEY'),
    secretKey: secret(config.secretKeyEnv ?? 'DSH_OBJECT_SECRET_KEY'),
    forcePathStyle: config.forcePathStyle ?? true,
  }
  const policy: Policy = {
    client: new S3Client(target),
    bucket: target.bucket,
    publicBaseUrl: config.publicBaseUrl.replace(/\/+$/, ''),
    keyPrefix: config.keyPrefix ?? '',
    maxBytes: config.maxBytes ?? 256 * 1024 * 1024,
    usersRoot: config.usersRoot,
    verifyPublic: config.verifyPublic ?? true,
  }

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: PUBLISH_DESCRIPTION,
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'The file to publish, as this sandbox sees it. Only the mounted paths (/workspace, /case, /global) are readable here, so pass an absolute path such as /workspace/报告.md; a file that exists only in the working directory must be written into a mounted path first.',
      },
      title: {
        type: 'string',
        description: 'Stem recorded in the object key; the source extension is appended. Defaults to the source file name without its extension.',
      },
      content_type: {
        type: 'string',
        description: 'Content type to store; inferred from the file extension when omitted.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          url: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          content_type: { type: 'string', required: true },
          source_path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const published = value as { key: string; url: string; bytes: number; content_type: string; source_path: string }
        return [{
          type: 'text',
          text: [
            `Published ${published.key} (${published.bytes} bytes, ${published.content_type}).`,
            `Download: [${basename(published.source_path)}](${published.url})`,
            'Copy that address into your reply exactly as it appears: do not shorten it, swap the host, or invent a different one.',
          ].join('\n'),
        }]
      },
      // 投影进 `tool/result` 事件的 `meta`：业务前端据此渲染下载项，不必解析结果文本，更不必读模型正文。
      presentationMeta: (_args, value) => {
        const published = value as { key: string; url: string; bytes: number; content_type: string; source_path: string }
        return {
          key: published.key,
          url: published.url,
          bytes: published.bytes,
          content_type: published.content_type,
          source_path: published.source_path,
        }
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const scope = currentScope(policy)
      const source = await resolveSource(scope, args.file_path, exec.agent?.session.header.cwd ?? '/workspace')
      if (source.size > policy.maxBytes) {
        throw new Error(`file_path ${JSON.stringify(source.containerPath)} is ${source.size} bytes, above this deployment's ${policy.maxBytes}-byte limit`)
      }
      const fileName = basename(source.host)
      const dot = fileName.lastIndexOf('.')
      const extension = dot > 0 ? fileName.slice(dot).toLowerCase() : ''
      // 标题自带与源文件相同的扩展名时只取主干：模型常把整个文件名当标题传来，直接拼会把键写成 a.csv.csv。
      const requested = args.title ?? fileName
      const titleDot = requested.lastIndexOf('.')
      const stem = segment(titleDot > 0 && requested.slice(titleDot).toLowerCase() === extension
        ? requested.slice(0, titleDot)
        : requested)
      const contentType = args.content_type ?? contentTypeFor(fileName)
      const key = await allocateKey(policy, scope, stem, extension, exec.signal)
      const payload = new Uint8Array(await fs.readFile(source.host))
      const written = await policy.client.putObject(key, payload, contentType, exec.signal)
      const url = urlFor(policy, key)
      if (policy.verifyPublic) await assertPublic(url, exec.signal)
      return {
        key,
        url,
        bytes: written.bytes,
        content_type: contentType,
        source_path: source.containerPath,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Publish to object storage', kind: 'other', rawInput: args.file_path }),
  }))
}

/**
 * 公开地址：路径式寻址把桶写在路径里，与客户端 SDK 的实际寻址保持一致。
 * @param policy - 对外基址与桶名。
 * @param key - 对象键。
 * @returns 不带凭据的绝对地址。
 */
export function urlFor(policy: Pick<Policy, 'publicBaseUrl' | 'bucket'>, key: string): string {
  const encoded = key.split('/').map(part => encodeURIComponent(part)).join('/')
  return `${policy.publicBaseUrl}/${encodeURIComponent(policy.bucket)}/${encoded}`
}

/**
 * 匿名确认公开地址可下载。
 * @param url - 待确认的地址。
 * @param signal - 取消信号。
 * @throws 没有凭据取不到该地址时，附上状态码。
 */
async function assertPublic(url: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { method: 'HEAD', signal })
  if (!response.ok) {
    throw new Error(`published object is not publicly readable at ${url} (status ${response.status}); the deployment's bucket policy must allow anonymous GetObject`)
  }
}

/**
 * 读取必填的密钥环境变量。
 * @param variable - 环境变量名。
 * @returns 该变量的值。
 * @throws 变量缺失或为空时。
 */
function secret(variable: string): string {
  const value = process.env[variable]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`object-store needs ${variable} to sign requests; set it in the deployment environment`)
  }
  return value
}
