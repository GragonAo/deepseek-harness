/**
 * 外部 MCP 注册表的启动配套：把配置文件里的 `mcpServers` 作为系统清单的初始种子写进库里。
 *
 * 只在两个条件同时成立时写：部署打开了 `mcp.external.seedFromConfig`，且库里的系统清单还是空的。
 * 一旦注册表里有内容，唯一真相就在库里——管理员删掉的那一条不该在下次重启时被配置复活，也不该
 * 因为配置文件还留着旧值就被改回去。
 *
 * @module @deepseek-ai/dsh-tenant-app/mcp-external
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ExternalMcpServerRecord } from '@deepseek-ai/dsh-mcp-servers'
import type { McpServerConfig } from './types.ts'

/**
 * 把配置文件里的服务器写成系统清单的初始种子。
 * @param ctx - 已挂上注册表的组合上下文。
 * @param servers - 配置里的 `mcpServers`；调用方只在它非空时调用。
 * @throws 注册表没起来，或某一行不被注册表接受（名字超预算、地址被策略拒绝、超出条数上限）。
 */
export async function seedSystemServers(ctx: Context, servers: readonly McpServerConfig[]): Promise<void> {
  const store = ctx.get('mcpServers')
  if (store === undefined) {
    throw new Error('外部 MCP 注册表没有起来，无法写入 mcpServers 种子')
  }
  // 库里已经有系统清单：那是管理员的判断，配置不再覆盖它。
  if (store.system().length > 0) return
  for (const server of servers) {
    // `updatedAt` 由注册表自己盖：种子只描述这一行是什么，不描述它什么时候被写过。
    const row: Omit<ExternalMcpServerRecord, 'updatedAt'> = {
      serverName: server.serverName,
      url: server.url,
      headers: server.headers ?? {},
      enabled: true,
      ...(server.toolCallTimeoutMs !== undefined ? { timeoutMs: server.toolCallTimeoutMs } : {}),
      ...(server.toolConcurrency !== undefined ? { toolConcurrency: server.toolConcurrency } : {}),
    }
    try {
      await store.upsertSystem(row)
    } catch (error) {
      throw new Error(
        `配置.mcpServers 里的 server "${server.serverName}" 写不进外部 MCP 注册表：${(error as Error).message}`,
        { cause: error },
      )
    }
  }
}
