const drainReader = async (reader) => {
  try {
    while (!(await reader.read()).done) { /* Отбрасываем остаток без буферизации. */ }
  } catch {
    // Соединение могло закрыться после раннего ответа 413.
  }
};

export const readStreamPrefix = async (stream, limit = 512) => {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const kept = chunk.subarray(0, Math.max(0, limit - size));
      chunks.push(kept);
      size += kept.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const prefix = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return prefix;
};

export const readJsonBodyLimited = async (request, limit) => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('payload_too_large');
  if (!request.body) throw new Error('invalid_json');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    size += chunk.byteLength;
    if (size > limit) {
      void drainReader(reader);
      throw new Error('payload_too_large');
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error('invalid_json');
  }
};

export const requestWithBodyLimit = (request, limit) => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('payload_too_large');
  if (!request.body) return request;
  const reader = request.body.getReader();
  let size = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        size += chunk.byteLength;
        if (size > limit) {
          void drainReader(reader);
          controller.error(new Error('payload_too_large'));
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      void drainReader(reader);
      return undefined;
    },
  });
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    duplex: 'half',
  });
};

export const readFormDataLimited = async (request, limit) => requestWithBodyLimit(request, limit).formData();
