import { afterEach, describe, expect, it } from 'vitest'
import { S3Client } from '../src/s3.ts'
import { startFakeS3 } from './fake-s3.ts'
import type { FakeS3 } from './fake-s3.ts'

const TARGET = {
  endpoint: 'http://rgw.example:80',
  bucket: 'dsh-public',
  region: 'us-east-1',
  accessKey: 'AKIAEXAMPLE',
  secretKey: 'secret-example',
  forcePathStyle: true,
}

const KEY = 'reports/acme/user-1/20261010_112040_report.docx'
const BODY = new TextEncoder().encode('report body')

const running: FakeS3[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()))
})

describe('S3Client', () => {
  it('writes an object, reads its length back, and deletes it', async () => {
    const s3 = await startFakeS3()
    running.push(s3)
    const client = new S3Client({ ...TARGET, endpoint: s3.origin })

    expect(await client.putObject(KEY, BODY, 'text/plain')).toEqual({ bytes: BODY.byteLength })
    expect(new TextDecoder().decode(s3.objects.get(KEY))).toBe('report body')
    expect(await client.headObject(KEY)).toBe(BODY.byteLength)

    await client.deleteObject(KEY)
    expect(await client.headObject(KEY)).toBeUndefined()
  })

  it('sends credentials, so a store that refuses unsigned writes accepts the request', async () => {
    const s3 = await startFakeS3()
    running.push(s3)
    const client = new S3Client({ ...TARGET, endpoint: s3.origin })

    await client.putObject(KEY, BODY, 'text/plain')
    expect(s3.authorizations).toHaveLength(1)
    expect(s3.authorizations[0]).toContain('AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/')
  })

  it('names the bucket in the path under path-style addressing', async () => {
    const s3 = await startFakeS3()
    running.push(s3)
    const client = new S3Client({ ...TARGET, endpoint: s3.origin, forcePathStyle: true })

    await client.putObject(KEY, BODY, 'text/plain')
    expect([...s3.objects.keys()]).toEqual([KEY.split('/').join('/')])
  })

  it('propagates a store failure instead of reporting a successful write', async () => {
    const s3 = await startFakeS3({ refuseWrites: true })
    running.push(s3)
    const client = new S3Client({ ...TARGET, endpoint: s3.origin })

    await expect(client.putObject(KEY, BODY, 'text/plain')).rejects.toMatchObject({
      $metadata: { httpStatusCode: 500 },
    })
    expect(s3.objects.size).toBe(0)
  })

  it('reports an absent object as undefined rather than as a failure', async () => {
    const s3 = await startFakeS3()
    running.push(s3)
    const client = new S3Client({ ...TARGET, endpoint: s3.origin })

    expect(await client.headObject('reports/acme/user-1/never-written.bin')).toBeUndefined()
  })
})
