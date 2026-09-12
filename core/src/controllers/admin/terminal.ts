/**
 * 网页终端：通过 Socket.IO 在浏览器里执行服务器（沙箱）shell 命令。
 *
 * 设计要点：
 * - 复用已有 socket.io 实例，握手阶段已完成 admin token 校验，此处再校验 role === 'admin'
 * - 每个 socket 维持一个长驻 shell 进程（cd 可持久化），命令结束用标记行回报 exit code 与 PWD
 * - 不引入 node-pty 等原生依赖，避免 CI/沙箱编译失败
 */
import type { AdminContext } from './context';
export {};

const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createModuleLogger } = require('../../services/logger');

const logger = createModuleLogger('terminal');

const MARKER_PREFIX = '__QQFARM_TERM__';
const MARKER_RE = new RegExp(`${MARKER_PREFIX}exit=(-?\\d+)__pwd=([\\s\\S]*)`);
const FLUSH_INTERVAL_MS = 30;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RUN_MS = 30 * 60 * 1000;
const MAX_PENDING = 512 * 1024;

interface TerminalSession {
    cwd: string;
    proc: any;
    busy: boolean;
    runningCommand: string;
    pending: string;
    flushTimer: NodeJS.Timeout | null;
    idleTimer: NodeJS.Timeout | null;
    runTimer: NodeJS.Timeout | null;
}

const sessions = new Map<string, TerminalSession>();

function isEnabled(): boolean {
    const flag = String(process.env.WEB_TERMINAL_ENABLED || '1').trim().toLowerCase();
    return flag !== '0' && flag !== 'false' && flag !== 'off' && flag !== 'no';
}

function resolveRoot(): string {
    const configured = String(process.env.WEB_TERMINAL_ROOT || '').trim();
    try {
        return path.resolve(configured || process.cwd());
    } catch {
        return process.cwd();
    }
}

function resolveShell(): { command: string, args: string[] } {
    if (process.platform === 'win32') {
        return { command: process.env.COMSPEC || 'cmd.exe', args: ['/Q'] };
    }
    const shell = String(process.env.SHELL || '').trim();
    if (shell && /\/bin\/(bash|zsh|sh)$/.test(shell)) {
        return { command: shell, args: [] };
    }
    return { command: '/bin/bash', args: [] };
}

function markerCommand(): string {
    if (process.platform === 'win32') {
        return `echo ${MARKER_PREFIX}exit=%errorlevel%__pwd=%cd%\r\n`;
    }
    return `printf '\\n${MARKER_PREFIX}exit=%s__pwd=%s\\n' "$?" "$PWD"\n`;
}

function isAdmin(socket: any): boolean {
    const session = socket && socket.data ? socket.data.session : null;
    return !!(session && session.role === 'admin');
}

function scheduleFlush(socket: any, session: TerminalSession): void {
    if (session.flushTimer) return;
    session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        flushOutput(socket, session);
    }, FLUSH_INTERVAL_MS);
}

function flushOutput(socket: any, session: TerminalSession): void {
    if (!session.pending) return;
    const raw = session.pending;
    session.pending = '';

    const segments = raw.split('\n');
    let out = '';
    for (let i = 0; i < segments.length; i++) {
        const isLast = i === segments.length - 1;
        const segment = segments[i].replace(/\r+$/, '');
        const marker = MARKER_RE.exec(segment);
        if (marker) {
            const prefix = segment.slice(0, marker.index).replace(/\s+$/, '');
            if (prefix) out += `${prefix}\n`;
            const code = Number(marker[1] || '0');
            const pwd = String(marker[2] || '').trim();
            if (pwd) session.cwd = pwd;
            session.busy = false;
            session.runningCommand = '';
            if (session.runTimer) {
                clearTimeout(session.runTimer);
                session.runTimer = null;
            }
            if (out) {
                socket.emit('terminal:output', { data: out });
                out = '';
            }
            socket.emit('terminal:exit', { code, cwd: session.cwd });
            continue;
        }
        out += isLast ? segments[i] : `${segments[i]}\n`;
    }
    if (out) socket.emit('terminal:output', { data: out });
}

function pushChunk(socket: any, session: TerminalSession, chunk: any): void {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    session.pending += text;
    if (session.pending.length > MAX_PENDING) {
        flushOutput(socket, session);
        return;
    }
    scheduleFlush(socket, session);
}

function touchIdle(session: TerminalSession, socket: any): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
        destroySession(socket);
    }, IDLE_TIMEOUT_MS);
    if (session.idleTimer && typeof session.idleTimer.unref === 'function') {
        session.idleTimer.unref();
    }
}

function destroySession(socket: any): void {
    const key = socket && socket.id;
    if (!key) return;
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    if (session.flushTimer) clearTimeout(session.flushTimer);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.runTimer) clearTimeout(session.runTimer);
    if (session.proc) {
        try {
            if (process.platform !== 'win32' && session.proc.pid) {
                process.kill(-session.proc.pid, 'SIGKILL');
            } else {
                session.proc.kill('SIGKILL');
            }
        } catch {
            // ignore
        }
        session.proc = null;
    }
}

function getSession(socket: any): TerminalSession {
    const key = socket.id;
    let session = sessions.get(key);
    if (session) return session;
    session = {
        cwd: resolveRoot(),
        proc: null,
        busy: false,
        runningCommand: '',
        pending: '',
        flushTimer: null,
        idleTimer: null,
        runTimer: null,
    };
    sessions.set(key, session);
    return session;
}

function ensureShell(socket: any, session: TerminalSession): any {
    if (session.proc && !session.proc.killed) return session.proc;

    const shell = resolveShell();
    const proc = spawn(shell.command, shell.args, {
        cwd: session.cwd,
        env: { ...process.env, TERM: 'dumb', PS1: '', QQFARM_WEB_TERMINAL: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
    });

    session.proc = proc;

    proc.stdout.on('data', (chunk: any) => pushChunk(socket, session, chunk));
    proc.stderr.on('data', (chunk: any) => pushChunk(socket, session, chunk));
    proc.on('error', (err: any) => {
        socket.emit('terminal:output', { data: `\r\n[shell error] ${String(err && err.message)}\r\n` });
    });
    proc.on('exit', () => {
        session.proc = null;
        session.busy = false;
        socket.emit('terminal:output', { data: '\r\n[shell exited]\r\n' });
        socket.emit('terminal:exit', { code: -1, cwd: session.cwd, shellExited: true });
    });

    return proc;
}

function signalRunning(session: TerminalSession, signal: string): boolean {
    const proc = session.proc;
    if (!proc) return false;
    const sig = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'].includes(signal) ? signal : 'SIGINT';
    try {
        if (process.platform !== 'win32' && proc.pid) {
            process.kill(-proc.pid, sig as NodeJS.Signals);
        } else {
            proc.kill(sig);
        }
        return true;
    } catch {
        try {
            proc.kill(sig);
            return true;
        } catch {
            return false;
        }
    }
}

function setupTerminal(ctx: AdminContext): void {
    if (!ctx || !ctx.io) return;
    const enabled = isEnabled();
    const root = resolveRoot();
    if (!enabled) {
        logger.warn('web terminal disabled by WEB_TERMINAL_ENABLED');
        return;
    }

    ctx.io.on('connection', (socket: any) => {
        socket.on('terminal:hello', () => {
            if (!isAdmin(socket)) {
                socket.emit('terminal:error', { message: '仅管理员可使用网页终端' });
                return;
            }
            const session = getSession(socket);
            touchIdle(session, socket);
            let user = 'root';
            try {
                user = os.userInfo().username || 'root';
            } catch {
                // container without passwd entry
            }
            socket.emit('terminal:ready', {
                cwd: session.cwd,
                root,
                user,
                host: os.hostname(),
                platform: process.platform,
            });
        });

        socket.on('terminal:run', (payload: any) => {
            if (!isAdmin(socket)) {
                socket.emit('terminal:error', { message: '仅管理员可使用网页终端' });
                return;
            }
            const body = payload && typeof payload === 'object' ? payload : {};
            const command = String(body.command || '').replace(/\r+$/, '');
            const session = getSession(socket);
            touchIdle(session, socket);

            if (!command.trim()) {
                socket.emit('terminal:exit', { code: 0, cwd: session.cwd });
                return;
            }

            // 有命令正在运行：本次输入作为 stdin 交给当前进程（支持交互输入）
            if (session.busy) {
                const proc = session.proc;
                if (proc && proc.stdin && !proc.stdin.destroyed) {
                    proc.stdin.write(command.endsWith('\n') ? command : `${command}\n`);
                }
                return;
            }

            try {
                logger.info('terminal run', { command: command.slice(0, 300) });
            } catch {
                // ignore logging errors
            }

            session.busy = true;
            session.runningCommand = command;
            const proc = ensureShell(socket, session);
            if (!proc || !proc.stdin) {
                session.busy = false;
                socket.emit('terminal:output', { data: '\r\n[shell 启动失败]\r\n' });
                socket.emit('terminal:exit', { code: 1, cwd: session.cwd });
                return;
            }
            proc.stdin.write(`${command}\n`);
            proc.stdin.write(markerCommand());

            if (session.runTimer) clearTimeout(session.runTimer);
            session.runTimer = setTimeout(() => {
                session.runTimer = null;
                if (!session.busy) return;
                signalRunning(session, 'SIGKILL');
                socket.emit('terminal:output', { data: '\r\n[命令超时，已强制终止]\r\n' });
                session.busy = false;
                socket.emit('terminal:exit', { code: 124, cwd: session.cwd });
            }, MAX_RUN_MS);
            if (session.runTimer && typeof session.runTimer.unref === 'function') {
                session.runTimer.unref();
            }
        });

        socket.on('terminal:input', (payload: any) => {
            if (!isAdmin(socket)) return;
            const body = payload && typeof payload === 'object' ? payload : {};
            const data = String(body.data || '');
            const session = sessions.get(socket.id);
            if (!session) return;
            touchIdle(session, socket);
            const proc = session.proc;
            if (proc && proc.stdin && !proc.stdin.destroyed) proc.stdin.write(data);
        });

        socket.on('terminal:signal', (payload: any) => {
            if (!isAdmin(socket)) return;
            const body = payload && typeof payload === 'object' ? payload : {};
            const session = sessions.get(socket.id);
            if (!session) return;
            const ok = signalRunning(session, String(body.signal || 'SIGINT'));
            if (!ok) {
                socket.emit('terminal:output', { data: '\r\n[没有正在运行的命令]\r\n' });
            }
        });

        socket.on('terminal:kill', () => {
            if (!isAdmin(socket)) return;
            const session = sessions.get(socket.id);
            if (!session) return;
            signalRunning(session, 'SIGKILL');
        });

        socket.on('disconnect', () => destroySession(socket));
    });
}

module.exports = { setupTerminal, destroySession };
