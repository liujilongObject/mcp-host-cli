import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Resource } from '@modelcontextprotocol/sdk/types.js'
import { MCPClientConfig } from './types.js'

export class MCPClient {
  private mcpClient: Client
  private transport: StdioClientTransport | SSEClientTransport | null = null
  private clientConfig: MCPClientConfig

  constructor(config: MCPClientConfig) {
    this.clientConfig = config

    // 创建 MCP 协议客户端
    this.mcpClient = new Client(
      {
        name: 'mcp-client-node',
        version: '1.0.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    )
  }

  private async generateCallStdioServerCommand(
    sourceServerConfig: MCPClientConfig['serverConfig']
  ): Promise<MCPClientConfig['serverConfig']> {
    const command = sourceServerConfig.command || ''
    if (command === 'npx') {
      return this.generateNpxCommand(sourceServerConfig)
    }
    if (command === 'uvx') {
      return this.generateUvxCommand(sourceServerConfig)
    }
    return sourceServerConfig
  }

  // 生成 npx 命令
  private async generateNpxCommand(serverConfig: MCPClientConfig['serverConfig']) {
    const currentNpxPath = 'npx'
    // 使用 npmmirror 镜像
    const npmMirrorRegistry = 'https://registry.npmmirror.com'

    const args = serverConfig.args || []
    const env = serverConfig.env || {}
    const cwd = serverConfig.cwd || undefined

    // 在 Windows 上使用 cmd 执行 npx 命令
    if (process.platform === 'win32') {
      return {
        command: 'cmd',
        args: ['/c', currentNpxPath, `--registry=${npmMirrorRegistry}`, ...args],
        env: {
          ...env,
          NPM_CONFIG_REGISTRY: npmMirrorRegistry,
        },
        cwd,
      }
    }

    // 在 Unix 系统上使用 bash 执行 npx 命令
    return {
      command: 'bash',
      args: ['-c', `${currentNpxPath} --registry=${npmMirrorRegistry} ${args.join(' ')}`],
      env: {
        ...env,
        NPM_CONFIG_REGISTRY: npmMirrorRegistry,
      },
      cwd,
    }
  }

  // python server: 生成 uvx 命令
  private async generateUvxCommand(serverConfig: MCPClientConfig['serverConfig']) {
    const currentUvxPath = 'uvx'

    const args = serverConfig.args || []
    const env = serverConfig.env || {}
    const cwd = serverConfig.cwd || undefined

    // 设置 uv 下载源
    const uvDefaultIndex = 'https://pypi.tuna.tsinghua.edu.cn/simple'

    // 在 Windows 上使用 cmd 执行 uvx 命令
    if (process.platform === 'win32') {
      return {
        command: 'cmd',
        args: ['/c', currentUvxPath, ...args],
        env: {
          ...env,
          UV_DEFAULT_INDEX: uvDefaultIndex,
        },
        cwd,
      }
    }

    // 在 Unix 系统上使用 bash 执行 uvx 命令
    return {
      command: 'bash',
      args: ['-c', `${currentUvxPath} ${args.join(' ')}`],
      env: {
        ...env,
        UV_DEFAULT_INDEX: uvDefaultIndex,
      },
      cwd,
    }
  }

  // 是否为 SSE URL
  private isSSEUrl(url: string): boolean {
    try {
      new URL(url)
      return url.startsWith('http://') || url.startsWith('https://')
    } catch {
      return false
    }
  }

  private createTransport(): StdioClientTransport | SSEClientTransport {
    switch (this.clientConfig.transportType) {
      case 'stdio':
        if (!this.clientConfig.serverConfig.command) {
          throw new Error('[MCP Client] Missing command for STDIO transport')
        }

        return new StdioClientTransport({
          command: this.clientConfig.serverConfig.command,
          args: this.clientConfig.serverConfig.args || [],
          env: this.clientConfig.serverConfig.env || undefined,
          cwd: this.clientConfig.serverConfig.cwd || undefined,
        })
      case 'sse':
        if (
          !this.clientConfig.serverConfig.sseUrl ||
          !this.isSSEUrl(this.clientConfig.serverConfig.sseUrl)
        ) {
          throw new Error('[MCP Client] invalid SSE URL')
        }

        return new SSEClientTransport(new URL(this.clientConfig.serverConfig.sseUrl))
      default:
        throw new Error(
          `[MCP Client] Unsupported transport type: ${this.clientConfig.transportType}`
        )
    }
  }

  async connectToServer() {
    // 最大重试次数
    const maxRetries = 3
    // 重试间隔（毫秒）
    const retryDelay = 1000
    let retries = 0

    while (retries < maxRetries) {
      try {
        // 处理 stdio 配置
        if (this.clientConfig.transportType === 'stdio') {
          const stdioServerConfig = await this.generateCallStdioServerCommand(
            this.clientConfig.serverConfig
          )
          console.log('[MCP Client] stdioServerConfig', JSON.stringify(stdioServerConfig, null, 2))
          this.clientConfig = {
            transportType: 'stdio',
            serverConfig: stdioServerConfig,
          }
        }

        this.transport = this.createTransport()
        await this.mcpClient.connect(this.transport)
        // 连接成功，跳出循环
        return
      } catch (error) {
        retries++
        console.log(`[MCP Client] 连接服务器失败，剩余重试次数: ${maxRetries - retries}`)
        // 如果已达到最大重试次数，则抛出错误
        if (retries >= maxRetries) {
          throw error
        }
        // 等待后重试
        await new Promise((resolve) => setTimeout(resolve, retryDelay))
      }
    }
  }

  async listTools() {
    try {
      let retries = 3
      let toolsResult

      while (retries > 0) {
        try {
          toolsResult = await this.mcpClient.listTools()
          break
        } catch (error) {
          // console.log(`获取工具列表失败，剩余重试次数: ${retries - 1}`)
          retries--
          if (retries === 0) throw error
          // 等待1秒后重试
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }

      return toolsResult?.tools ?? []
    } catch (error) {
      throw error
    }
  }

  async callTool(toolName: string, toolArgs: any) {
    try {
      const result = await this.mcpClient.callTool(
        {
          name: toolName,
          arguments: toolArgs,
        },
        undefined,
        { timeout: 5 * 60 * 1000 } // 5分钟超时
      )

      return result
    } catch (error) {
      throw error
    }
  }

  async listResources(): Promise<Resource[]> {
    try {
      const result = await this.mcpClient.listResources()
      return result.resources
    } catch (error) {
      throw error
    }
  }

  async readResource(uri: string): Promise<Partial<Resource>[]> {
    try {
      const result = await this.mcpClient.readResource({ uri })
      return result.contents
    } catch (error) {
      throw error
    }
  }

  async cleanup() {
    await this.mcpClient.close()
  }
}
