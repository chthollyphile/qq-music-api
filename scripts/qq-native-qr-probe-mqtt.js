// Minimal MQTT 5 codec for the QQ Music native QR event stream; no runtime dependency is required.

const MQTT_HOST = 'mu.y.qq.com';
const MQTT_INITIAL_PATH = '/ws/handshake';
const UTF8_PROPERTIES = new Set([0x03, 0x08, 0x12, 0x15, 0x1a, 0x1c, 0x1f]);
const UINT16_PROPERTIES = new Set([0x13, 0x21, 0x22, 0x23]);
const UINT32_PROPERTIES = new Set([0x02, 0x11, 0x18, 0x27]);
const BYTE_PROPERTIES = new Set([0x01, 0x17, 0x19, 0x24, 0x25, 0x28, 0x29, 0x2a]);
const BINARY_PROPERTIES = new Set([0x09, 0x16]);

function encodeVariableByteInteger(value) {
  if (!Number.isInteger(value) || value < 0 || value > 268435455) throw new RangeError('invalid MQTT variable integer');
  const bytes = [];
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) digit |= 0x80;
    bytes.push(digit);
  } while (value > 0);
  return Buffer.from(bytes);
}

function decodeVariableByteInteger(buffer, offset = 0) {
  let multiplier = 1;
  let value = 0;
  let bytes = 0;
  while (bytes < 4) {
    if (offset + bytes >= buffer.length) return null;
    const digit = buffer[offset + bytes];
    value += (digit & 0x7f) * multiplier;
    bytes += 1;
    if ((digit & 0x80) === 0) return { value, bytes };
    multiplier *= 128;
  }
  throw new Error('malformed MQTT variable integer');
}

function encodeUtf8(value) {
  const data = Buffer.from(String(value), 'utf8');
  if (data.length > 65535) throw new RangeError('MQTT UTF-8 value too long');
  const size = Buffer.allocUnsafe(2);
  size.writeUInt16BE(data.length);
  return Buffer.concat([size, data]);
}

function encodeProperties(properties) {
  const chunks = [];
  if (properties.authMethod) chunks.push(Buffer.from([0x15]), encodeUtf8(properties.authMethod));
  for (const [key, value] of properties.userProperties || []) {
    chunks.push(Buffer.from([0x26]), encodeUtf8(key), encodeUtf8(value));
  }
  const encoded = Buffer.concat(chunks);
  return Buffer.concat([encodeVariableByteInteger(encoded.length), encoded]);
}

function wrapPacket(header, body) {
  return Buffer.concat([Buffer.from([header]), encodeVariableByteInteger(body.length), body]);
}

function buildConnectPacket(clientId, qrcodeId, keepAlive = 45) {
  const protocol = Buffer.concat([encodeUtf8('MQTT'), Buffer.from([0x05, 0x02])]);
  const keepAliveBytes = Buffer.allocUnsafe(2);
  keepAliveBytes.writeUInt16BE(keepAlive);
  const properties = encodeProperties({
    authMethod: 'pass',
    userProperties: [
      ['tmeAppID', 'qqmusic'],
      ['business', 'management'],
      ['hashTag', qrcodeId],
      ['clientTag', 'management.user'],
      ['userID', qrcodeId],
    ],
  });
  return wrapPacket(0x10, Buffer.concat([protocol, keepAliveBytes, properties, encodeUtf8(clientId)]));
}

function buildSubscribePacket(qrcodeId, packetId = 1) {
  const id = Buffer.allocUnsafe(2);
  id.writeUInt16BE(packetId);
  const properties = encodeProperties({
    userProperties: [
      ['authorization', 'tmelogin'],
      ['pubsub', 'unicast'],
    ],
  });
  const topic = encodeUtf8(`management.qrcode_login/${qrcodeId}`);
  return wrapPacket(0x82, Buffer.concat([id, properties, topic, Buffer.from([0x00])]));
}

function readUtf8(buffer, offset) {
  if (offset + 2 > buffer.length) throw new Error('truncated MQTT UTF-8 length');
  const length = buffer.readUInt16BE(offset);
  const start = offset + 2;
  const end = start + length;
  if (end > buffer.length) throw new Error('truncated MQTT UTF-8 value');
  return { value: buffer.subarray(start, end).toString('utf8'), next: end };
}

function skipBinary(buffer, offset) {
  if (offset + 2 > buffer.length) throw new Error('truncated MQTT binary length');
  const length = buffer.readUInt16BE(offset);
  const next = offset + 2 + length;
  if (next > buffer.length) throw new Error('truncated MQTT binary value');
  return next;
}

function parseProperties(buffer, offset) {
  const lengthInfo = decodeVariableByteInteger(buffer, offset);
  if (!lengthInfo) throw new Error('truncated MQTT properties length');
  let cursor = offset + lengthInfo.bytes;
  const end = cursor + lengthInfo.value;
  if (end > buffer.length) throw new Error('truncated MQTT properties');
  const values = { userProperties: {} };
  while (cursor < end) {
    const id = buffer[cursor];
    cursor += 1;
    if (id === 0x26) {
      const key = readUtf8(buffer, cursor);
      const value = readUtf8(buffer, key.next);
      values.userProperties[key.value] = value.value;
      cursor = value.next;
    } else if (UTF8_PROPERTIES.has(id)) {
      const decoded = readUtf8(buffer, cursor);
      if (id === 0x1c) values.serverReference = decoded.value;
      if (id === 0x1f) values.reasonString = decoded.value;
      cursor = decoded.next;
    } else if (UINT16_PROPERTIES.has(id)) cursor += 2;
    else if (UINT32_PROPERTIES.has(id)) cursor += 4;
    else if (BYTE_PROPERTIES.has(id)) cursor += 1;
    else if (BINARY_PROPERTIES.has(id)) cursor = skipBinary(buffer, cursor);
    else if (id === 0x0b) {
      const variable = decodeVariableByteInteger(buffer, cursor);
      if (!variable) throw new Error('truncated MQTT subscription identifier');
      cursor += variable.bytes;
    } else throw new Error(`unsupported MQTT property 0x${id.toString(16)}`);
    if (cursor > end) throw new Error('MQTT property exceeds declared length');
  }
  return { values, next: end };
}

function splitPackets(buffer) {
  const packets = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const remaining = decodeVariableByteInteger(buffer, cursor + 1);
    if (!remaining) break;
    const headerBytes = 1 + remaining.bytes;
    const end = cursor + headerBytes + remaining.value;
    if (end > buffer.length) break;
    packets.push(buffer.subarray(cursor, end));
    cursor = end;
  }
  return { packets, rest: buffer.subarray(cursor) };
}

function parseConnack(packet) {
  const remaining = decodeVariableByteInteger(packet, 1);
  if (!remaining || (packet[0] >> 4) !== 2) throw new Error('not a complete MQTT CONNACK');
  const bodyOffset = 1 + remaining.bytes;
  if (bodyOffset + 2 > packet.length) throw new Error('truncated MQTT CONNACK');
  const reasonCode = packet[bodyOffset + 1];
  const properties = parseProperties(packet, bodyOffset + 2).values;
  return { reasonCode, ...properties };
}

function parsePublishPacket(packet) {
  const remaining = decodeVariableByteInteger(packet, 1);
  if (!remaining || (packet[0] >> 4) !== 3) throw new Error('not a complete MQTT PUBLISH');
  let cursor = 1 + remaining.bytes;
  const topic = readUtf8(packet, cursor);
  cursor = topic.next;
  const qos = (packet[0] >> 1) & 0x03;
  if (qos > 0) cursor += 2;
  const properties = parseProperties(packet, cursor);
  cursor = properties.next;
  const rawPayload = packet.subarray(cursor).toString('utf8');
  let payload = null;
  try {
    payload = rawPayload ? JSON.parse(rawPayload) : null;
  } catch {
    payload = null;
  }
  return { topic: topic.value, type: properties.values.userProperties.type || null, payload };
}

function buildRedirectPath(path, serverReference) {
  const parts = path.replace(/\/$/, '').split('/');
  if (parts.at(-1).includes(':')) parts[parts.length - 1] = serverReference;
  else parts.push(serverReference);
  return parts.join('/');
}

function createPacketQueue(websocket) {
  let buffered = Buffer.alloc(0);
  const packets = [];
  const waiters = [];
  let terminalError = null;
  function settle() {
    while (waiters.length && packets.length) waiters.shift().resolve(packets.shift());
    if (terminalError) while (waiters.length) waiters.shift().reject(terminalError);
  }
  websocket.addEventListener('message', (event) => {
    const incoming = Buffer.from(event.data);
    const split = splitPackets(Buffer.concat([buffered, incoming]));
    buffered = split.rest;
    packets.push(...split.packets);
    settle();
  });
  websocket.addEventListener('error', () => {
    terminalError = new Error('MQTT WebSocket error');
    settle();
  });
  websocket.addEventListener('close', (event) => {
    terminalError = new Error(`MQTT WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
    settle();
  });
  return {
    next(timeoutMs) {
      if (packets.length) return Promise.resolve(packets.shift());
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('MQTT packet timeout'));
        }, timeoutMs);
        waiter.resolve = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiter.reject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });
    },
  };
}

function requireWebSocketRuntime(WebSocketClass = globalThis.WebSocket) {
  if (!WebSocketClass) {
    throw new Error('QQ native QR probe requires Node.js 22+ with the global WebSocket API');
  }
  return WebSocketClass;
}

function openWebSocket(path) {
  return new Promise((resolve, reject) => {
    const WebSocketClass = requireWebSocketRuntime();
    const websocket = new WebSocketClass(`wss://${MQTT_HOST}${path}`, 'mqtt');
    websocket.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      websocket.close();
      reject(new Error('MQTT WebSocket handshake timeout'));
    }, 20000);
    websocket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(websocket);
    }, { once: true });
    websocket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('MQTT WebSocket handshake failed'));
    }, { once: true });
  });
}

async function connectMqtt(qrcodeId) {
  let path = MQTT_INITIAL_PATH;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const websocket = await openWebSocket(path);
    const queue = createPacketQueue(websocket);
    const clientId = `${Date.now()}${cryptoRandomDigits(4)}`;
    websocket.send(buildConnectPacket(clientId, qrcodeId));
    const connack = parseConnack(await queue.next(20000));
    if (connack.reasonCode === 0) return { websocket, queue, path };
    websocket.close();
    if (![0x9c, 0x9d].includes(connack.reasonCode) || !connack.serverReference || redirects === 3) {
      throw new Error(`MQTT CONNACK rejected: 0x${connack.reasonCode.toString(16)}${connack.reasonString ? ` (${connack.reasonString})` : ''}`);
    }
    path = buildRedirectPath(path, connack.serverReference);
  }
  throw new Error('MQTT redirect limit exceeded');
}

function cryptoRandomDigits(length) {
  let result = '';
  for (let index = 0; index < length; index += 1) result += Math.floor(Math.random() * 10);
  return result;
}

async function listenForQrEvents(qrcodeId, { timeoutMs = 180000, onEvent }) {
  const { websocket, queue, path } = await connectMqtt(qrcodeId);
  const ping = setInterval(() => {
    if (websocket.readyState === WebSocket.OPEN) websocket.send(Buffer.from([0xc0, 0x00]));
  }, 30000);
  try {
    websocket.send(buildSubscribePacket(qrcodeId));
    while (true) {
      const packet = await queue.next(20000);
      const packetType = packet[0] >> 4;
      if (packetType === 9) {
        const reasonCode = packet.at(-1);
        if (reasonCode >= 0x80) throw new Error(`MQTT SUBACK rejected: 0x${reasonCode.toString(16)}`);
        break;
      }
      if (packetType === 3) onEvent(parsePublishPacket(packet));
    }
    onEvent({ type: 'waiting', payload: null, mqttPath: path });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const packet = await queue.next(Math.max(1, deadline - Date.now()));
      const packetType = packet[0] >> 4;
      if (packetType === 13) continue;
      if (packetType !== 3) continue;
      const event = parsePublishPacket(packet);
      onEvent(event);
      if (['cookies', 'canceled', 'timeout', 'loginFailed'].includes(event.type)) return event;
    }
    return { type: 'timeout', payload: null };
  } finally {
    clearInterval(ping);
    websocket.close();
  }
}

module.exports = {
  buildConnectPacket,
  buildRedirectPath,
  buildSubscribePacket,
  decodeVariableByteInteger,
  encodeProperties,
  encodeUtf8,
  encodeVariableByteInteger,
  listenForQrEvents,
  parseConnack,
  parseProperties,
  parsePublishPacket,
  requireWebSocketRuntime,
  splitPackets,
  wrapPacket,
};
