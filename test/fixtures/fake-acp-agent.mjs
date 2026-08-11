#!/usr/bin/env node
// Minimal ACP agent used by acp.test.ts. Behavior switches on FAKE_ACP_MODE:
//   happy     - one tool call with a permission ask, then a fenced-JSON reply
//   refuse    - prompt ends with stopReason "refusal"
//   authgate  - session/new fails with code -32000
//   silent    - exits mid-turn without answering the prompt
//   stall     - accepts the prompt but never sends any further output
//   quota     - fenced-JSON reply with _meta.quota reporting a served model alias
//   cancelled - prompt ends with stopReason "cancelled" but still reports partial _meta.quota
//   retry-quota - first invocation (tracked via FAKE_ACP_STATE_FILE) refuses with partial
//                 _meta.quota, second invocation succeeds with its own _meta.quota

import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_ACP_MODE ?? 'happy';
const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notifyUpdate(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

let nextOutgoingId = 1000;
const sessionId = 'sess-fake-1';

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }
  if (msg.method === 'session/new') {
    if (mode === 'authgate') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'authentication required' } });
      return;
    }
    process.env.FAKE_ACP_SEEN_MCP = JSON.stringify(msg.params?.mcpServers ?? []);
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
    return;
  }
  if (msg.method === 'session/prompt') {
    if (mode === 'silent') {
      process.exit(3);
    }
    if (mode === 'stall') {
      return;
    }
    if (mode === 'refuse') {
      notifyUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'no.' } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } });
      return;
    }
    if (mode === 'quota') {
      notifyUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done.\n```json\n{"verdict":"PASS"}\n```\n' },
      });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          stopReason: 'end_turn',
          _meta: {
            quota: {
              token_count: { input_tokens: 500, output_tokens: 120 },
              model_usage: [
                { model: 'gemini-3.5-flash', token_count: { input_tokens: 500, output_tokens: 120 } },
              ],
            },
          },
        },
      });
      return;
    }
    if (mode === 'retry-quota') {
      const stateFile = process.env.FAKE_ACP_STATE_FILE;
      if (!existsSync(stateFile)) {
        writeFileSync(stateFile, '1');
        notifyUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'no.' } });
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            stopReason: 'refusal',
            _meta: {
              quota: {
                token_count: { input_tokens: 80, output_tokens: 12 },
                model_usage: [{ model: 'gemini-3.5-flash', token_count: { input_tokens: 80, output_tokens: 12 } }],
              },
            },
          },
        });
        return;
      }
      notifyUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done.\n```json\n{"verdict":"PASS"}\n```\n' },
      });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          stopReason: 'end_turn',
          _meta: {
            quota: {
              token_count: { input_tokens: 500, output_tokens: 120 },
              model_usage: [
                { model: 'gemini-3.5-flash', token_count: { input_tokens: 500, output_tokens: 120 } },
              ],
            },
          },
        },
      });
      return;
    }
    if (mode === 'cancelled') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          stopReason: 'cancelled',
          _meta: {
            quota: {
              token_count: { input_tokens: 80, output_tokens: 12 },
              model_usage: [{ model: 'gemini-3.5-flash', token_count: { input_tokens: 80, output_tokens: 12 } }],
            },
          },
        },
      });
      return;
    }
    notifyUpdate(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    notifyUpdate(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'read the readme',
      kind: 'read',
      status: 'pending',
    });
    send({
      jsonrpc: '2.0',
      id: nextOutgoingId++,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'call-1', title: 'read the readme' },
        options: [
          { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' },
          { optionId: 'allow-1', name: 'Allow', kind: 'allow_once' },
        ],
      },
    });
    // The permission response arrives on a later line; finish the turn when it does.
    pendingPrompt = msg.id;
    return;
  }
  if (msg.id !== undefined && msg.result !== undefined && pendingPrompt !== null) {
    const outcome = msg.result?.outcome?.outcome;
    const optionId = msg.result?.outcome?.optionId;
    const verdict = outcome === 'selected' && optionId === 'allow-1' ? 'PASS' : 'FAIL';
    notifyUpdate(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' });
    notifyUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Done.\n```json\n{"verdict":"' + verdict + '"}\n```\n' },
    });
    send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'end_turn' } });
    pendingPrompt = null;
  }
});

let pendingPrompt = null;
