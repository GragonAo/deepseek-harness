import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TENANT_SESSIONS_DIR_NAME,
  TENANT_SKILL_DIR_NAME,
  TENANT_TIER_DIRS,
  TENANT_USERS_DIR_NAME,
  TENANT_WORK_DIR_NAME,
  sandboxSessionDir,
  tenantDirectories,
} from '../src/index.ts'

const ROOT = '/root/work'

describe('sandbox session directory', () => {
  it('gives each session a directory of its own under the mounted session root', () => {
    // 会话之间因此不抢同一层，而这一层在挂载进来的会话根上：容器销毁后它仍然在。
    // 它不在 `/workspace` 里——那样用户案件工作区的挂载就会交出这个人所有会话的目录树。
    expect(sandboxSessionDir({ DSH_SESSION_ID: 'session-cdb4d064' })).toBe('/sessions/session-cdb4d064')
  })

  it('has no session directory for an exec that carries no session', () => {
    // 探针与宿主自己的工具调用没有会话，也就没有该由平台指定的工作目录。
    expect(sandboxSessionDir(undefined)).toBeUndefined()
    expect(sandboxSessionDir({})).toBeUndefined()
  })

  it('refuses a session id that could leave the workspace', () => {
    // 会话 id 直接成为路径分量，所以只有普通目录名进得了沙箱：前导短横线也拒绝，
    // 否则它会成为 mkdir 自己的一个选项。
    for (const id of ['../../etc', '.', '..', 'a/b', '', 'session 7', '-p']) {
      expect(sandboxSessionDir({ DSH_SESSION_ID: id })).toBeUndefined()
    }
  })
})

describe('tenant directories', () => {
  it('names every host directory the sandbox mounts, parents before children', () => {
    const dirs = tenantDirectories({
      dataRoot: join(ROOT, 'tenants/acme/data'),
      workspaceRoot: join(ROOT, 'tenants/acme/workspace'),
      toolsRoot: join(ROOT, 'tenants/acme/tools'),
      usersRoot: join(ROOT, 'users'),
      archiveRoot: join(ROOT, 'archive'),
      members: ['user_1'],
    })

    // 沙箱挂的就是这批路径：dataRoot、/tools 的来源、案件工作目录与其三层、每个成员在案件下的
    // 工作目录与会话目录、以及 usersRoot 下那一份。多一个少一个都会让挂载落在没人建过的路径上。
    expect(dirs).toEqual([
      join(ROOT, 'tenants/acme/data'),
      join(ROOT, 'archive'),
      join(ROOT, 'tenants/acme/tools'),
      join(ROOT, 'tenants/acme/workspace'),
      join(ROOT, 'tenants/acme/workspace/work'),
      join(ROOT, 'tenants/acme/workspace/config'),
      join(ROOT, 'tenants/acme/workspace/skills'),
      join(ROOT, 'tenants/acme/workspace/tools'),
      join(ROOT, 'tenants/acme/workspace/users/user_1'),
      join(ROOT, 'tenants/acme/workspace/users/user_1/work'),
      join(ROOT, 'tenants/acme/workspace/users/user_1/sessions'),
      join(ROOT, 'users/user_1'),
      join(ROOT, 'users/user_1/work'),
      join(ROOT, 'users/user_1/config'),
      join(ROOT, 'users/user_1/skills'),
      join(ROOT, 'users/user_1/tools'),
    ])
  })

  it('names a member that no tenant has admitted yet', () => {
    // usersEnsure 先于接纳：那时还没有任何租户工作区可进，只有 usersRoot 下的那一份。
    expect(tenantDirectories({ usersRoot: join(ROOT, 'users'), members: ['user_1'] })).toEqual([
      join(ROOT, 'users/user_1'),
      join(ROOT, 'users/user_1/work'),
      join(ROOT, 'users/user_1/config'),
      join(ROOT, 'users/user_1/skills'),
      join(ROOT, 'users/user_1/tools'),
    ])
  })

  it('drops the roots this deployment does not configure', () => {
    // 缺一个根意味着没配它，而不是它下面的目录不用建：这里只有在 workspaceRoot 与
    // members 都给得出东西的那部分。
    expect(tenantDirectories({ workspaceRoot: join(ROOT, 'ws'), members: ['user_1'] })).toEqual([
      join(ROOT, 'ws'),
      join(ROOT, 'ws/work'),
      join(ROOT, 'ws/config'),
      join(ROOT, 'ws/skills'),
      join(ROOT, 'ws/tools'),
      join(ROOT, 'ws/users/user_1'),
      join(ROOT, 'ws/users/user_1/work'),
      join(ROOT, 'ws/users/user_1/sessions'),
    ])
  })

  it('lists a directory once when two roots name it', () => {
    expect(tenantDirectories({ dataRoot: join(ROOT, 'same'), toolsRoot: join(ROOT, 'same') }))
      .toEqual([join(ROOT, 'same')])
  })

  it('carries the tier names the sandbox mounts by name', () => {
    // 沙箱按 `<workspaceRoot>/shared/skills` 这个名字挂案件技能层：这份名单是建目录与
    // 出挂载表之间的接口，改名必须两边同时改。
    expect(TENANT_TIER_DIRS).toEqual(['config', 'skills', 'tools'])
    expect([TENANT_WORK_DIR_NAME, TENANT_USERS_DIR_NAME, TENANT_SESSIONS_DIR_NAME, TENANT_SKILL_DIR_NAME])
      .toEqual(['work', 'users', 'sessions', 'skills'])
  })

  it('covers the deployment-wide roots the sandbox mounts from', () => {
    // 这两个根不属于任何租户，但沙箱从它们挂载：system 根用到的是它下面的技能层，
    // Python 环境根本身就是挂载点，所以清单只给这两个路径、不多建。
    const system = join('/opt/dsh', 'system')
    const python = join('/opt/dsh', 'pyenv')
    expect(tenantDirectories({ systemRoot: system, pythonRoot: python }))
      .toEqual([system, join(system, 'skills'), python])
  })
})
