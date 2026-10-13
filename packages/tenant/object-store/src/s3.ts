/**
 * S3 兼容存储客户端：官方 SDK 之上的对象级封装。
 *
 * 只暴露对象级 PUT / HEAD / DELETE，因为公开下载讲的是**匿名读**——对象由部署侧配置的桶策略开放，
 * 用户拿到的是一条不带凭据的地址，所以本模块不实现签名 GET，也不实现桶级或策略级接口（建桶与桶策略
 * 属于部署步骤，不由运行中的服务改）。签名算法、寻址方式、重试与校验和都由 SDK 负责，本模块只做三件事：
 * 把部署配置映射成一次 SDK 客户端构造、把对象键固定到配置的桶上、把「对象不存在」翻译成 `undefined`。
 * @module @deepseek-ai/dsh-object-store/s3
 */

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client as AwsS3Client,
} from '@aws-sdk/client-s3'

/** 一个 S3 端点与它的一组凭据。 */
export interface S3Target {
  /** 端点源：`scheme://host[:port]`，不含桶。 */
  readonly endpoint: string
  /** 桶名。 */
  readonly bucket: string
  /** 签名区域；RGW 的默认 zonegroup 用 `us-east-1` 即可。 */
  readonly region: string
  /** 访问密钥 ID。 */
  readonly accessKey: string
  /** 秘密访问密钥。 */
  readonly secretKey: string
  /** 路径式寻址：把桶写在路径里（`/bucket/key`）而不是主机名前缀里。 */
  readonly forcePathStyle: boolean
}

/** 一次对象写入的结果。 */
export interface PutResult {
  /** 写入的字节数。 */
  readonly bytes: number
}

/**
 * 对象级 S3 客户端。
 *
 * 失败一律抛出：一次发布要么对象确实进了桶，要么调用方拿到错误，不存在「返回成功但没写进去」。
 */
export class S3Client {
  private readonly s3: AwsS3Client
  private readonly bucket: string

  /**
   * @param target - 端点、桶与凭据。
   */
  constructor(target: S3Target) {
    this.bucket = target.bucket
    this.s3 = new AwsS3Client({
      endpoint: target.endpoint,
      region: target.region,
      forcePathStyle: target.forcePathStyle,
      credentials: { accessKeyId: target.accessKey, secretAccessKey: target.secretKey },
    })
  }

  /**
   * 写入一个对象。
   * @param key - 对象键。
   * @param payload - 对象字节。
   * @param contentType - 写入的 `Content-Type`，浏览器据此决定打开还是下载。
   * @param signal - 取消信号。
   * @returns 写入的字节数。
   */
  async putObject(
    key: string,
    payload: Uint8Array<ArrayBuffer>,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<PutResult> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: payload,
      ContentType: contentType,
    }), options(signal))
    return { bytes: payload.byteLength }
  }

  /**
   * 读取一个对象的长度。
   * @param key - 对象键。
   * @param signal - 取消信号。
   * @returns 字节数；对象不存在时为 `undefined`。
   */
  async headObject(key: string, signal?: AbortSignal): Promise<number | undefined> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), options(signal))
      return head.ContentLength ?? 0
    } catch (error) {
      if (absent(error)) return undefined
      throw error
    }
  }

  /**
   * 删除一个对象。删除不存在的对象同样是成功：S3 的 DELETE 是幂等的。
   * @param key - 对象键。
   * @param signal - 取消信号。
   */
  async deleteObject(key: string, signal?: AbortSignal): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), options(signal))
  }
}

/**
 * 把取消信号翻译成 SDK 的请求选项。
 * @param signal - 调用方的取消信号。
 * @returns 无信号时不设超时，由调用方自己的信号控制生命周期。
 */
function options(signal: AbortSignal | undefined): { abortSignal?: AbortSignal } {
  return signal === undefined ? {} : { abortSignal: signal }
}

/**
 * 判断一次失败是不是「对象不存在」。
 *
 * HEAD 没有响应体，所以存储只能靠状态码表达缺失；`NoSuchKey` 与 `NotFound` 是 S3 与 RGW 在带响应体
 * 的请求上给出的两种命名，一并认掉。
 * @param error - 捕获到的失败。
 * @returns 缺失时为 `true`。
 */
function absent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  if (named.$metadata?.httpStatusCode === 404) return true
  return named.name === 'NotFound' || named.name === 'NoSuchKey'
}
