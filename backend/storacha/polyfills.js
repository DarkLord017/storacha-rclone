// Polyfills for V8 (v8go) - Browser APIs not available in pure V8
// These must be loaded BEFORE the Storacha SDK

// TextEncoder / TextDecoder polyfill
if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    encode(str) {
      const arr = [];
      for (let i = 0; i < str.length; i++) {
        let charCode = str.charCodeAt(i);
        if (charCode < 0x80) {
          arr.push(charCode);
        } else if (charCode < 0x800) {
          arr.push(0xc0 | (charCode >> 6), 0x80 | (charCode & 0x3f));
        } else if (charCode < 0xd800 || charCode >= 0xe000) {
          arr.push(0xe0 | (charCode >> 12), 0x80 | ((charCode >> 6) & 0x3f), 0x80 | (charCode & 0x3f));
        } else {
          i++;
          charCode = 0x10000 + (((charCode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
          arr.push(
            0xf0 | (charCode >> 18),
            0x80 | ((charCode >> 12) & 0x3f),
            0x80 | ((charCode >> 6) & 0x3f),
            0x80 | (charCode & 0x3f)
          );
        }
      }
      return new Uint8Array(arr);
    }
  };
}

if (typeof TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    decode(bytes) {
      if (!bytes) return '';
      const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let result = '';
      let i = 0;
      while (i < arr.length) {
        let charCode;
        if (arr[i] < 0x80) {
          charCode = arr[i++];
        } else if (arr[i] < 0xe0) {
          charCode = ((arr[i++] & 0x1f) << 6) | (arr[i++] & 0x3f);
        } else if (arr[i] < 0xf0) {
          charCode = ((arr[i++] & 0x0f) << 12) | ((arr[i++] & 0x3f) << 6) | (arr[i++] & 0x3f);
        } else {
          charCode = ((arr[i++] & 0x07) << 18) | ((arr[i++] & 0x3f) << 12) | ((arr[i++] & 0x3f) << 6) | (arr[i++] & 0x3f);
          if (charCode > 0xffff) {
            charCode -= 0x10000;
            result += String.fromCharCode(0xd800 + (charCode >> 10));
            charCode = 0xdc00 + (charCode & 0x3ff);
          }
        }
        result += String.fromCharCode(charCode);
      }
      return result;
    }
  };
}

// atob / btoa (Base64)
if (typeof atob === 'undefined') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  
  globalThis.atob = function(input) {
    let str = String(input).replace(/[=]+$/, '');
    let output = '';
    
    if (str.length % 4 === 1) {
      throw new Error("'atob' failed: Invalid base64 string");
    }
    
    for (let bc = 0, bs = 0, buffer, i = 0;
      (buffer = str.charAt(i++));
      ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4)
        ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
        : 0
    ) {
      buffer = chars.indexOf(buffer);
    }
    
    return output;
  };
  
  globalThis.btoa = function(input) {
    let str = String(input);
    let output = '';
    
    for (let block = 0, charCode, i = 0, map = chars;
      str.charAt(i | 0) || (map = '=', i % 1);
      output += map.charAt(63 & (block >> (8 - (i % 1) * 8)))
    ) {
      charCode = str.charCodeAt((i += 3 / 4));
      if (charCode > 0xff) {
        throw new Error("'btoa' failed: Character out of range");
      }
      block = (block << 8) | charCode;
    }
    
    return output;
  };
}

// URL polyfill (basic)
if (typeof URL === 'undefined') {
  globalThis.URL = class URL {
    constructor(url, base) {
      if (base) {
        // Simple base URL resolution
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = base.replace(/\/[^\/]*$/, '/') + url;
        }
      }
      
      const match = url.match(/^(https?:)\/\/([^\/\?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/);
      if (match) {
        this.protocol = match[1];
        this.host = match[2];
        this.hostname = match[2].split(':')[0];
        this.port = match[2].split(':')[1] || '';
        this.pathname = match[3] || '/';
        this.search = match[4] || '';
        this.hash = match[5] || '';
        this.href = url;
        this.origin = `${this.protocol}//${this.host}`;
      } else {
        throw new Error(`Invalid URL: ${url}`);
      }
    }
    
    toString() {
      return this.href;
    }
  };
}

// URLSearchParams polyfill (basic)
if (typeof URLSearchParams === 'undefined') {
  globalThis.URLSearchParams = class URLSearchParams {
    constructor(init) {
      this._params = new Map();
      if (typeof init === 'string') {
        init = init.startsWith('?') ? init.slice(1) : init;
        init.split('&').forEach(pair => {
          const [key, value] = pair.split('=').map(decodeURIComponent);
          this.append(key, value);
        });
      }
    }
    
    append(key, value) {
      const values = this._params.get(key) || [];
      values.push(String(value));
      this._params.set(key, values);
    }
    
    get(key) {
      const values = this._params.get(key);
      return values ? values[0] : null;
    }
    
    toString() {
      const parts = [];
      this._params.forEach((values, key) => {
        values.forEach(value => {
          parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        });
      });
      return parts.join('&');
    }
  };
}

// Blob polyfill (basic)
if (typeof Blob === 'undefined') {
  globalThis.Blob = class Blob {
    constructor(parts = [], options = {}) {
      this._parts = parts;
      this.type = options.type || '';
      
      // Calculate size
      this.size = parts.reduce((acc, part) => {
        if (typeof part === 'string') {
          return acc + new TextEncoder().encode(part).length;
        } else if (part instanceof Uint8Array) {
          return acc + part.length;
        } else if (part instanceof ArrayBuffer) {
          return acc + part.byteLength;
        } else if (part && part.size !== undefined) {
          return acc + part.size;
        }
        return acc;
      }, 0);
    }
    
    async arrayBuffer() {
      const encoder = new TextEncoder();
      const buffers = this._parts.map(part => {
        if (typeof part === 'string') {
          return encoder.encode(part);
        } else if (part instanceof Uint8Array) {
          return part;
        } else if (part instanceof ArrayBuffer) {
          return new Uint8Array(part);
        } else if (part && part._parts) {
          // Nested Blob
          return new Uint8Array(0); // Simplified
        }
        return new Uint8Array(0);
      });
      
      const totalLength = buffers.reduce((acc, buf) => acc + buf.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const buf of buffers) {
        result.set(buf, offset);
        offset += buf.length;
      }
      return result.buffer;
    }
    
    async text() {
      const buffer = await this.arrayBuffer();
      return new TextDecoder().decode(buffer);
    }
    
    slice(start, end, type) {
      // Simplified slice
      return new Blob(this._parts, { type: type || this.type });
    }
  };
}

// File polyfill
if (typeof File === 'undefined') {
  globalThis.File = class File extends Blob {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

// fetch polyfill - This is critical and complex
// For v8go, we need to implement this via Go callbacks
// This is a placeholder that will be replaced by Go-implemented fetch
if (typeof fetch === 'undefined') {
  globalThis.fetch = async function(url, options = {}) {
    // This needs to be implemented via Go callbacks
    // For now, throw an error indicating it needs Go implementation
    throw new Error('fetch is not implemented in v8go. Network requests must be handled by Go.');
  };
}

// Headers polyfill
if (typeof Headers === 'undefined') {
  globalThis.Headers = class Headers {
    constructor(init) {
      this._headers = new Map();
      if (init) {
        if (init instanceof Headers) {
          init.forEach((value, key) => this.append(key, value));
        } else if (Array.isArray(init)) {
          init.forEach(([key, value]) => this.append(key, value));
        } else if (typeof init === 'object') {
          Object.entries(init).forEach(([key, value]) => this.append(key, value));
        }
      }
    }
    
    append(key, value) {
      key = key.toLowerCase();
      const values = this._headers.get(key) || [];
      values.push(String(value));
      this._headers.set(key, values);
    }
    
    get(key) {
      const values = this._headers.get(key.toLowerCase());
      return values ? values.join(', ') : null;
    }
    
    has(key) {
      return this._headers.has(key.toLowerCase());
    }
    
    set(key, value) {
      this._headers.set(key.toLowerCase(), [String(value)]);
    }
    
    delete(key) {
      this._headers.delete(key.toLowerCase());
    }
    
    forEach(callback) {
      this._headers.forEach((values, key) => {
        callback(values.join(', '), key, this);
      });
    }
  };
}

// Response polyfill (basic)
if (typeof Response === 'undefined') {
  globalThis.Response = class Response {
    constructor(body, options = {}) {
      this._body = body;
      this.status = options.status || 200;
      this.statusText = options.statusText || 'OK';
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new Headers(options.headers);
    }
    
    async json() {
      const text = await this.text();
      return JSON.parse(text);
    }
    
    async text() {
      if (typeof this._body === 'string') {
        return this._body;
      }
      return '';
    }
    
    async arrayBuffer() {
      if (this._body instanceof ArrayBuffer) {
        return this._body;
      }
      const encoder = new TextEncoder();
      return encoder.encode(String(this._body)).buffer;
    }
  };
}

// Request polyfill (basic)
if (typeof Request === 'undefined') {
  globalThis.Request = class Request {
    constructor(input, options = {}) {
      this.url = typeof input === 'string' ? input : input.url;
      this.method = options.method || 'GET';
      this.headers = new Headers(options.headers);
      this.body = options.body || null;
    }
  };
}

// AbortController / AbortSignal polyfill
if (typeof AbortController === 'undefined') {
  globalThis.AbortSignal = class AbortSignal {
    constructor() {
      this.aborted = false;
      this._listeners = [];
    }
    
    addEventListener(type, listener) {
      if (type === 'abort') {
        this._listeners.push(listener);
      }
    }
    
    removeEventListener(type, listener) {
      if (type === 'abort') {
        this._listeners = this._listeners.filter(l => l !== listener);
      }
    }
  };
  
  globalThis.AbortController = class AbortController {
    constructor() {
      this.signal = new AbortSignal();
    }
    
    abort() {
      this.signal.aborted = true;
      this.signal._listeners.forEach(listener => {
        try {
          listener({ type: 'abort' });
        } catch (e) {}
      });
    }
  };
}

// crypto.getRandomValues polyfill (basic - NOT cryptographically secure!)
if (typeof crypto === 'undefined') {
  globalThis.crypto = {
    getRandomValues(array) {
      // WARNING: This is NOT cryptographically secure!
      // For production use, this needs to be implemented via Go's crypto/rand
      for (let i = 0; i < array.length; i++) {
        array[i] = Math.floor(Math.random() * 256);
      }
      return array;
    },
    
    randomUUID() {
      // Generate a v4 UUID
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 1
      
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    
    subtle: {
      // Stub for crypto.subtle - needs Go implementation for real crypto
      async digest(algorithm, data) {
        throw new Error('crypto.subtle.digest needs Go implementation');
      },
      async sign(algorithm, key, data) {
        throw new Error('crypto.subtle.sign needs Go implementation');
      },
      async verify(algorithm, key, signature, data) {
        throw new Error('crypto.subtle.verify needs Go implementation');
      },
      async encrypt(algorithm, key, data) {
        throw new Error('crypto.subtle.encrypt needs Go implementation');
      },
      async decrypt(algorithm, key, data) {
        throw new Error('crypto.subtle.decrypt needs Go implementation');
      },
      async generateKey(algorithm, extractable, keyUsages) {
        throw new Error('crypto.subtle.generateKey needs Go implementation');
      },
      async importKey(format, keyData, algorithm, extractable, keyUsages) {
        throw new Error('crypto.subtle.importKey needs Go implementation');
      },
      async exportKey(format, key) {
        throw new Error('crypto.subtle.exportKey needs Go implementation');
      }
    }
  };
}

// console polyfill (if not available)
if (typeof console === 'undefined') {
  globalThis.console = {
    log: function() {},
    error: function() {},
    warn: function() {},
    info: function() {},
    debug: function() {}
  };
}

// setTimeout / setInterval / clearTimeout / clearInterval
// These need Go implementation for proper async handling
if (typeof setTimeout === 'undefined') {
  // These are stubs - real implementation needs Go integration
  const timers = new Map();
  let timerId = 0;
  
  globalThis.setTimeout = function(callback, delay, ...args) {
    // In v8go, this needs special handling through Go
    // This is a stub that won't actually work for async operations
    const id = ++timerId;
    timers.set(id, { callback, args, delay });
    // Immediately execute for now (not ideal but prevents hanging)
    try {
      callback(...args);
    } catch (e) {
      console.error('setTimeout callback error:', e);
    }
    return id;
  };
  
  globalThis.clearTimeout = function(id) {
    timers.delete(id);
  };
  
  globalThis.setInterval = function(callback, delay, ...args) {
    return setTimeout(callback, delay, ...args);
  };
  
  globalThis.clearInterval = function(id) {
    clearTimeout(id);
  };
}

// queueMicrotask
if (typeof queueMicrotask === 'undefined') {
  globalThis.queueMicrotask = function(callback) {
    Promise.resolve().then(callback);
  };
}

// structuredClone (basic)
if (typeof structuredClone === 'undefined') {
  globalThis.structuredClone = function(obj) {
    return JSON.parse(JSON.stringify(obj));
  };
}

// Performance API stub
if (typeof performance === 'undefined') {
  const startTime = Date.now();
  globalThis.performance = {
    now() {
      return Date.now() - startTime;
    },
    timeOrigin: startTime
  };
}

// ReadableStream stub (very basic)
if (typeof ReadableStream === 'undefined') {
  globalThis.ReadableStream = class ReadableStream {
    constructor(underlyingSource) {
      this._source = underlyingSource;
      this._controller = null;
      this._closed = false;
    }
    
    getReader() {
      const self = this;
      return {
        read: async () => {
          if (self._closed) {
            return { done: true, value: undefined };
          }
          return { done: true, value: undefined };
        },
        releaseLock: () => {},
        cancel: async () => { self._closed = true; }
      };
    }
    
    pipeThrough(transform) {
      return transform.readable;
    }
    
    pipeTo(dest) {
      return Promise.resolve();
    }
    
    tee() {
      return [this, new ReadableStream()];
    }
  };
}

// WritableStream stub
if (typeof WritableStream === 'undefined') {
  globalThis.WritableStream = class WritableStream {
    constructor(underlyingSink) {
      this._sink = underlyingSink;
      this._closed = false;
    }
    
    getWriter() {
      const self = this;
      return {
        write: async (chunk) => {
          if (self._sink && self._sink.write) {
            await self._sink.write(chunk);
          }
        },
        close: async () => {
          self._closed = true;
          if (self._sink && self._sink.close) {
            await self._sink.close();
          }
        },
        abort: async () => { self._closed = true; },
        releaseLock: () => {}
      };
    }
  };
}

// TransformStream stub
if (typeof TransformStream === 'undefined') {
  globalThis.TransformStream = class TransformStream {
    constructor(transformer = {}) {
      this._transformer = transformer;
      
      const self = this;
      this.readable = new ReadableStream({
        start(controller) {
          self._readableController = controller;
        }
      });
      
      this.writable = new WritableStream({
        write(chunk) {
          if (self._transformer.transform) {
            return self._transformer.transform(chunk, {
              enqueue: (data) => {},
              error: (e) => {},
              terminate: () => {}
            });
          }
        },
        close() {
          if (self._transformer.flush) {
            return self._transformer.flush({
              enqueue: (data) => {},
              error: (e) => {},
              terminate: () => {}
            });
          }
        }
      });
    }
  };
}

// ByteLengthQueuingStrategy
if (typeof ByteLengthQueuingStrategy === 'undefined') {
  globalThis.ByteLengthQueuingStrategy = class ByteLengthQueuingStrategy {
    constructor(options) {
      this.highWaterMark = options.highWaterMark || 1;
    }
    size(chunk) {
      return chunk.byteLength || chunk.length || 0;
    }
  };
}

// CountQueuingStrategy
if (typeof CountQueuingStrategy === 'undefined') {
  globalThis.CountQueuingStrategy = class CountQueuingStrategy {
    constructor(options) {
      this.highWaterMark = options.highWaterMark || 1;
    }
    size() {
      return 1;
    }
  };
}

// Mark polyfills as loaded
globalThis.__V8GO_POLYFILLS_LOADED__ = true;

// IndexedDB stub (in-memory)
if (typeof indexedDB === 'undefined') {
  const databases = new Map();
  
  class IDBRequest extends EventTarget {
    constructor() {
      super();
      this.result = null;
      this.error = null;
      this.onsuccess = null;
      this.onerror = null;
      this.readyState = 'pending';
    }
    
    _success(result) {
      this.readyState = 'done';
      this.result = result;
      const event = { target: this, type: 'success' };
      if (this.onsuccess) {
        this.onsuccess(event);
      }
      this.dispatchEvent(event);
    }
    
    _error(error) {
      this.readyState = 'done';
      this.error = error;
      const event = { target: this, type: 'error' };
      if (this.onerror) {
        this.onerror(event);
      }
      this.dispatchEvent(event);
    }
  }
  
  class IDBObjectStore {
    constructor(name, db) {
      this.name = name;
      this._db = db;
      this._data = new Map();
    }
    
    put(value, key) {
      const request = new IDBRequest();
      setTimeout(() => {
        try {
          const k = key || value.id || Date.now().toString();
          this._data.set(k, structuredClone(value));
          request._success(k);
        } catch (e) {
          request._error(e);
        }
      }, 0);
      return request;
    }
    
    get(key) {
      const request = new IDBRequest();
      setTimeout(() => {
        try {
          request._success(this._data.get(key));
        } catch (e) {
          request._error(e);
        }
      }, 0);
      return request;
    }
    
    delete(key) {
      const request = new IDBRequest();
      setTimeout(() => {
        try {
          this._data.delete(key);
          request._success(undefined);
        } catch (e) {
          request._error(e);
        }
      }, 0);
      return request;
    }
    
    clear() {
      const request = new IDBRequest();
      setTimeout(() => {
        try {
          this._data.clear();
          request._success(undefined);
        } catch (e) {
          request._error(e);
        }
      }, 0);
      return request;
    }
    
    getAll() {
      const request = new IDBRequest();
      setTimeout(() => {
        try {
          request._success(Array.from(this._data.values()));
        } catch (e) {
          request._error(e);
        }
      }, 0);
      return request;
    }
    
    getAllKeys() {
      const request = new IDBRequest();
      setTimeout(() => {
        try {
          request._success(Array.from(this._data.keys()));
        } catch (e) {
          request._error(e);
        }
      }, 0);
      return request;
    }
    
    createIndex() {
      return this;
    }
  }
  
  class IDBTransaction {
    constructor(db, storeNames, mode) {
      this._db = db;
      this._storeNames = storeNames;
      this.mode = mode;
      this.oncomplete = null;
      this.onerror = null;
    }
    
    objectStore(name) {
      if (!this._db._stores.has(name)) {
        this._db._stores.set(name, new IDBObjectStore(name, this._db));
      }
      return this._db._stores.get(name);
    }
  }
  
  class IDBDatabase {
    constructor(name, version) {
      this.name = name;
      this.version = version;
      this._stores = new Map();
      this.objectStoreNames = {
        contains: (name) => this._stores.has(name)
      };
    }
    
    transaction(storeNames, mode = 'readonly') {
      return new IDBTransaction(this, storeNames, mode);
    }
    
    createObjectStore(name, options) {
      const store = new IDBObjectStore(name, this);
      this._stores.set(name, store);
      return store;
    }
    
    deleteObjectStore(name) {
      this._stores.delete(name);
    }
    
    close() {}
  }
  
  class IDBOpenDBRequest extends IDBRequest {
    constructor() {
      super();
      this.onupgradeneeded = null;
      this.onblocked = null;
    }
  }
  
  globalThis.indexedDB = {
    open(name, version = 1) {
      const request = new IDBOpenDBRequest();
      
      setTimeout(() => {
        try {
          let db = databases.get(name);
          const isNew = !db;
          const needsUpgrade = isNew || (db && db.version < version);
          
          if (!db) {
            db = new IDBDatabase(name, version);
            databases.set(name, db);
          }
          
          if (needsUpgrade && request.onupgradeneeded) {
            const event = {
              target: { result: db },
              oldVersion: isNew ? 0 : db.version,
              newVersion: version
            };
            db.version = version;
            request.onupgradeneeded(event);
          }
          
          request._success(db);
        } catch (e) {
          request._error(e);
        }
      }, 0);
      
      return request;
    },
    
    deleteDatabase(name) {
      const request = new IDBRequest();
      setTimeout(() => {
        databases.delete(name);
        request._success(undefined);
      }, 0);
      return request;
    }
  };
  
  globalThis.IDBKeyRange = {
    only(value) {
      return { lower: value, upper: value };
    },
    lowerBound(lower, open) {
      return { lower, lowerOpen: open };
    },
    upperBound(upper, open) {
      return { upper, upperOpen: open };
    },
    bound(lower, upper, lowerOpen, upperOpen) {
      return { lower, upper, lowerOpen, upperOpen };
    }
  };
}

// localStorage stub (in-memory)
if (typeof localStorage === 'undefined') {
  const storage = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
    get length() {
      return storage.size;
    },
    key(index) {
      return Array.from(storage.keys())[index] || null;
    }
  };
}

// sessionStorage stub
if (typeof sessionStorage === 'undefined') {
  const storage = new Map();
  globalThis.sessionStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
    get length() {
      return storage.size;
    },
    key(index) {
      return Array.from(storage.keys())[index] || null;
    }
  };
}

// Event and EventTarget polyfill
if (typeof Event === 'undefined') {
  globalThis.Event = class Event {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = options.bubbles || false;
      this.cancelable = options.cancelable || false;
      this.defaultPrevented = false;
    }
    
    preventDefault() {
      this.defaultPrevented = true;
    }
    
    stopPropagation() {}
    stopImmediatePropagation() {}
  };
}

if (typeof EventTarget === 'undefined') {
  globalThis.EventTarget = class EventTarget {
    constructor() {
      this._listeners = new Map();
    }
    
    addEventListener(type, listener) {
      if (!this._listeners.has(type)) {
        this._listeners.set(type, []);
      }
      this._listeners.get(type).push(listener);
    }
    
    removeEventListener(type, listener) {
      const listeners = this._listeners.get(type);
      if (listeners) {
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      }
    }
    
    dispatchEvent(event) {
      const listeners = this._listeners.get(event.type);
      if (listeners) {
        listeners.forEach(listener => {
          try {
            listener(event);
          } catch (e) {
            console.error('Event listener error:', e);
          }
        });
      }
      return !event.defaultPrevented;
    }
  };
}

// CustomEvent
if (typeof CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type, options);
      this.detail = options.detail || null;
    }
  };
}

console.log('[v8go] Polyfills loaded');
