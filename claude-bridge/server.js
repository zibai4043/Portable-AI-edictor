/**
 * Claude Code Bridge Server
 *
 * 用于远程监控和控制 Claude Code CLI
 *
 * 使用方式：
 * 1. npm install
 * 2. node server.js
 * 3. 在另一个终端运行：cloudflared tunnel --url ws://localhost:8765
 * 4. 使用生成的 URL 在手机 APP 中连接
 */

const WebSocket = require('ws');
const { spawn } = require('child_process');
const crypto = require('crypto');
const readline = require('readline');

// 配置
const CONFIG = {
  port: process.env.PORT || 8765,
  authToken: process.env.AUTH_TOKEN || generateToken(),
  claudePath: 'claude',
  workDir: process.cwd()
};

// 生成安全 token
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// 日志
const log = {
  info: (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`),
  error: (msg) => console.error(`[${new Date().toLocaleTimeString()}] ERROR: ${msg}`)
};

// WebSocket 服务器
const wss = new WebSocket.Server({ port: CONFIG.port });

// 客户端列表
const clients = new Set();

// Claude CLI 进程
let claudeProcess = null;
let claudeBuffer = '';

// 启动 Claude CLI
function startClaude() {
  log.info('Starting Claude CLI...');

  // 使用 --print 模式，输出到 stdout
  claudeProcess = spawn(CONFIG.claudePath, [
    '--print',
    '--output-format', 'stream-json'
  ], {
    cwd: CONFIG.workDir,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // 处理输出
  claudeProcess.stdout.on('data', (data) => {
    claudeBuffer += data.toString();
    processClaudeBuffer();
  });

  // 处理错误
  claudeProcess.stderr.on('data', (data) => {
    const text = data.toString();
    log.error(`Claude stderr: ${text}`);
    broadcast({ type: 'error', content: text });
  });

  // 进程结束
  claudeProcess.on('close', (code) => {
    log.info(`Claude process exited with code ${code}`);
    broadcast({ type: 'system', subtype: 'claude_exit', code: code });
    claudeProcess = null;
  });

  // 错误
  claudeProcess.on('error', (err) => {
    log.error(`Failed to start Claude: ${err.message}`);
    broadcast({ type: 'error', content: `无法启动 Claude CLI: ${err.message}` });
  });
}

// 处理 Claude 输出缓冲
function processClaudeBuffer() {
  const lines = claudeBuffer.split('\n');
  claudeBuffer = lines.pop() || '';

  for (const line of lines) {
    if (line.trim()) {
      try {
        const message = JSON.parse(line);
        handleClaudeMessage(message);
      } catch (err) {
        // 不是 JSON，当作普通文本
        broadcast({ type: 'text', content: line });
      }
    }
  }
}

// 处理 Claude 消息
function handleClaudeMessage(message) {
  log.info(`Claude message: ${message.type || 'unknown'}`);

  // 广播给所有客户端
  broadcast({
    type: 'claude_event',
    data: message
  });
}

// 广播消息
function broadcast(message) {
  const payload = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// 发送消息给 Claude
function sendToClaude(content) {
  if (claudeProcess && claudeProcess.stdin.writable) {
    claudeProcess.stdin.write(content + '\n');
    log.info(`Sent to Claude: ${content.substring(0, 50)}...`);
    return true;
  }
  return false;
}

// WebSocket 连接处理
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
  const token = url.searchParams.get('token');

  // 验证 token
  if (token !== CONFIG.authToken) {
    log.error(`Invalid token from ${req.socket.remoteAddress}`);
    ws.close(1008, 'Invalid token');
    return;
  }

  log.info(`Client connected from ${req.socket.remoteAddress}`);
  clients.add(ws);

  // 发送欢迎消息
  ws.send(JSON.stringify({
    type: 'system',
    subtype: 'connected',
    message: 'Connected to Claude Bridge Server',
    token: CONFIG.authToken
  }));

  // 如果 Claude 还没启动，启动它
  if (!claudeProcess) {
    startClaude();
  }

  // 接收客户端消息
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleClientMessage(ws, message);
    } catch (err) {
      log.error(`Invalid message: ${err.message}`);
    }
  });

  // 断开连接
  ws.on('close', () => {
    log.info('Client disconnected');
    clients.delete(ws);
  });

  // 错误
  ws.on('error', (err) => {
    log.error(`WebSocket error: ${err.message}`);
    clients.delete(ws);
  });
});

// 处理客户端消息
function handleClientMessage(ws, message) {
  log.info(`Client message: ${message.type}`);

  switch (message.type) {
    case 'user_input':
      // 发送用户输入给 Claude
      if (message.content) {
        sendToClaude(message.content);
        broadcast({ type: 'user', content: message.content });
      }
      break;

    case 'command':
      // 执行命令
      handleCommand(ws, message.command, message.args);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
      break;

    default:
      log.info(`Unknown message type: ${message.type}`);
  }
}

// 处理命令
function handleCommand(ws, command, args) {
  switch (command) {
    case 'restart':
      // 重启 Claude
      if (claudeProcess) {
        claudeProcess.kill();
        claudeProcess = null;
      }
      startClaude();
      ws.send(JSON.stringify({ type: 'system', subtype: 'restarted' }));
      break;

    case 'stop':
      // 停止 Claude
      if (claudeProcess) {
        claudeProcess.kill();
        claudeProcess = null;
        broadcast({ type: 'system', subtype: 'stopped' });
      }
      break;

    case 'clear':
      // 清空缓冲
      claudeBuffer = '';
      ws.send(JSON.stringify({ type: 'system', subtype: 'cleared' }));
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', content: `Unknown command: ${command}` }));
  }
}

// 心跳检测
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// 启动服务器
wss.on('listening', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║        Claude Code Bridge Server Started                   ║
╠════════════════════════════════════════════════════════════╣
║  WebSocket URL:  ws://localhost:${CONFIG.port}                 ║
║  Auth Token:     ${CONFIG.authToken}              ║
╠════════════════════════════════════════════════════════════╣
║  使用方式:                                                 ║
║  1. 在手机 APP 中连接此服务器                              ║
║  2. 启动隧道: cloudflared tunnel --url ws://localhost:8765 ║
╚════════════════════════════════════════════════════════════╝
  `);
});

// 优雅关闭
process.on('SIGINT', () => {
  log.info('Shutting down...');
  if (claudeProcess) {
    claudeProcess.kill();
  }
  wss.close(() => {
    log.info('Server closed');
    process.exit(0);
  });
});

log.info('Server starting...');
