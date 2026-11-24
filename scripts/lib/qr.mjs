/**
 * 终端二维码生成（零依赖）
 *
 * 微信扫码登录只给一个 `qrcode_img_content` 链接，必须把它编码成二维码让
 * 用户用手机扫。为了不在登录脚本里引入第三方依赖，这里实现 QR 规范里够用
 * 的那一小部分：Byte 模式、纠错等级 L、版本 1–10、固定掩码 0。
 *
 * 刻意不做的事：不做自动掩码选择、不做 Kanji / 数字 / 字母模式、不写文件。
 * 登录链接约 100 字节，版本 6 就够；固定掩码 0 是合法编码，扫描器不关心
 * 选择哪张掩码。
 *
 * 实现依据：ISO/IEC 18004 的模块放置、Reed–Solomon 纠错与格式信息规则。
 */

/** 纠错等级 L 的 RS 分块表：总码字数、每块纠错码字数、各数据块的数据码字数 */
const L_BLOCKS = {
  1: { total: 26, ec: 7, data: [19] },
  2: { total: 44, ec: 10, data: [34] },
  3: { total: 70, ec: 15, data: [55] },
  4: { total: 100, ec: 20, data: [80] },
  5: { total: 134, ec: 26, data: [108] },
  6: { total: 172, ec: 18, data: [68, 68] },
  7: { total: 196, ec: 20, data: [78, 78] },
  8: { total: 242, ec: 24, data: [97, 97] },
  9: { total: 292, ec: 30, data: [116, 116] },
  10: { total: 346, ec: 18, data: [68, 68, 69, 69] },
};

/** 对齐图案中心（包含 6 与 size-7 的角点会被跳过） */
const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MAX_VERSION = 10;
/** Byte 模式在版本 10-L 下最多 271 字节；登录链接远小于它 */
const MAX_BYTES = 271;

/** GF(256) 指数 / 对数表（本原多项式 0x11D） */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if ((value & 0x100) !== 0) {
      value ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    EXP[i] = EXP[i - 255];
  }
}

function gfMultiply(a, b) {
  if (a === 0 || b === 0) {
    return 0;
  }
  return EXP[LOG[a] + LOG[b]];
}

/** x^degree 的生成多项式，系数按高次到低次排列 */
function generatorPoly(degree) {
  let gen = [1];
  for (let i = 0; i < degree; i += 1) {
    const alpha = EXP[i];
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j += 1) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMultiply(gen[j], alpha);
    }
    gen = next;
  }
  return gen;
}

/** 对一个数据块计算纠错码字 */
function reedSolomon(data, degree) {
  const gen = generatorPoly(degree);
  const remainder = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let j = 0; j < degree; j += 1) {
      remainder[j] ^= gfMultiply(gen[j + 1], factor);
    }
  }
  return remainder;
}

function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) {
    bits.push(((value >>> i) & 1) !== 0);
  }
}

/**
 * 选择能装下文本的最小版本并生成数据码字。
 * 超出 271 字节时抛错，调用方应提示链接过长。
 */
function buildDataCodewords(bytes) {
  if (bytes.length > MAX_BYTES) {
    throw new Error(`二维码内容过长（${bytes.length} 字节，上限 ${MAX_BYTES}）`);
  }
  let version = 0;
  for (let candidate = 1; candidate <= MAX_VERSION; candidate += 1) {
    const table = L_BLOCKS[candidate];
    const capacity = table.data.reduce((sum, size) => sum + size, 0);
    const lengthBits = candidate <= 9 ? 8 : 16;
    if (4 + lengthBits + bytes.length * 8 <= capacity * 8) {
      version = candidate;
      break;
    }
  }
  if (version === 0) {
    throw new Error(`二维码内容过长（${bytes.length} 字节）`);
  }

  const table = L_BLOCKS[version];
  const capacityBits = table.data.reduce((sum, size) => sum + size, 0) * 8;
  const bits = [];
  pushBits(bits, 0b0100, 4); // Byte 模式
  pushBits(bits, bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) {
    pushBits(bits, byte, 8);
  }
  // 终止符最多 4 位，然后补到字节边界
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i += 1) {
    bits.push(false);
  }
  while (bits.length % 8 !== 0) {
    bits.push(false);
  }
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) {
      value = (value << 1) | (bits[i + j] ? 1 : 0);
    }
    codewords.push(value);
  }
  // 填充码字 0xEC / 0x11 交替
  let pad = 0xec;
  while (codewords.length < capacityBits / 8) {
    codewords.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return { version, codewords };
}

/** 把数据码字切成块、加纠错码字并交织，得到最终比特流 */
function buildFinalBits(version, codewords) {
  const table = L_BLOCKS[version];
  const blocks = [];
  let offset = 0;
  for (const size of table.data) {
    const data = codewords.slice(offset, offset + size);
    offset += size;
    blocks.push({ data, ec: reedSolomon(data, table.ec) });
  }
  const final = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) {
        final.push(block.data[i]);
      }
    }
  }
  for (let i = 0; i < table.ec; i += 1) {
    for (const block of blocks) {
      final.push(block.ec[i]);
    }
  }
  const bits = [];
  for (const byte of final) {
    pushBits(bits, byte, 8);
  }
  return bits;
}

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

/** 写格式信息（纠错等级 + 掩码编号 + BCH 校验） */
function drawFormatBits(modules, size, mask) {
  const data = (0b01 << 3) | mask; // 纠错等级 L = 01
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  const bits = ((data << 10) | remainder) ^ 0x5412;

  const set = (x, y, bit) => {
    modules[y][x] = bit;
  };
  for (let i = 0; i <= 5; i += 1) {
    set(8, i, getBit(bits, i));
  }
  set(8, 7, getBit(bits, 6));
  set(8, 8, getBit(bits, 7));
  set(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) {
    set(14 - i, 8, getBit(bits, i));
  }
  for (let i = 0; i < 8; i += 1) {
    set(size - 1 - i, 8, getBit(bits, i));
  }
  for (let i = 8; i < 15; i += 1) {
    set(8, size - 15 + i, getBit(bits, i));
  }
  set(8, size - 8, true); // 固定暗模块
}

/** 写版本信息（版本 7 起） */
function drawVersionBits(modules, size, version) {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  const bits = (version << 12) | remainder;
  for (let i = 0; i < 18; i += 1) {
    const bit = getBit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = bit;
    modules[a][b] = bit;
  }
}

/** 生成 QR 矩阵：`true` 表示深色模块，`false` 表示浅色模块 */
export function qrMatrix(text, options = {}) {
  const bytes = [...Buffer.from(text, "utf8")];
  const { version, codewords } = buildDataCodewords(bytes);
  const bits = buildFinalBits(version, codewords);
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunction = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) {
      return;
    }
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // 定位图案 + 分隔符
  const drawFinder = (x0, y0) => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const distance = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        setFunction(x0 + dx, y0 + dy, distance !== 2 && distance !== 4);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);

  // 时序图案
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunction(i, 6, dark);
    setFunction(6, i, dark);
  }

  // 对齐图案
  const centers = ALIGNMENT[version];
  for (const cy of centers) {
    for (const cx of centers) {
      const corner =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === size - 7) ||
        (cx === size - 7 && cy === 6);
      if (corner) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          setFunction(cx + dx, cy + dy, distance !== 1);
        }
      }
    }
  }

  // 预留格式信息区域（时序图案的 (6,8) / (8,6) 不动）
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      setFunction(8, i, false);
      setFunction(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFunction(size - 1 - i, 8, false);
  }
  for (let i = 8; i < 15; i += 1) {
    setFunction(8, size - 15 + i, false);
  }
  setFunction(8, size - 8, true); // 固定暗模块

  if (version >= 7) {
    drawVersionBits(modules, size, version);
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      isFunction[b][a] = true;
      isFunction[a][b] = true;
    }
  }

  // 数据比特按右到左、上下交替填入
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < bits.length) {
          modules[y][x] = bits[bitIndex];
          bitIndex += 1;
        }
      }
    }
  }

  // 固定掩码 0：((row + col) % 2 === 0)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isFunction[y][x] && (y + x) % 2 === 0) {
        modules[y][x] = !modules[y][x];
      }
    }
  }

  drawFormatBits(modules, size, 0);
  return modules;
}

/**
 * 把矩阵渲染成终端文本。
 *
 * 用上下半块把两行合成一行，并强制黑字 / 白底：深色模块画成黑色，浅色
 * 模块留白，因此深色终端主题下也能被手机正确识别。
 *
 * 静默区按二维码规范保留 4 个模块（左右各 4 列，上下各 2 行文本，每行
 * 文本对应 2 行模块）。少了静默区，很多手机扫不出紧贴字符边缘的二维码。
 */
export function renderQrTerminal(matrix, options = {}) {
  const size = matrix.length;
  const quiet = options.quiet ?? 4;
  const width = size + quiet * 2;
  const pad = " ".repeat(quiet);
  const blank = `\x1b[30;47m${" ".repeat(width)}\x1b[0m`;
  const rows = [];
  for (let i = 0; i < Math.ceil(quiet / 2); i += 1) {
    rows.push(blank);
  }
  for (let y = 0; y < size; y += 2) {
    let line = `\x1b[30;47m${pad}`;
    for (let x = 0; x < size; x += 1) {
      const top = matrix[y][x];
      const bottom = y + 1 < size ? matrix[y + 1][x] : false;
      let glyph = " ";
      if (top && bottom) {
        glyph = "█";
      } else if (top) {
        glyph = "▀";
      } else if (bottom) {
        glyph = "▄";
      }
      line += glyph;
    }
    line += `${pad}\x1b[0m`;
    rows.push(line);
  }
  for (let i = 0; i < Math.ceil(quiet / 2); i += 1) {
    rows.push(blank);
  }
  return rows.join("\n");
}

/** 一步生成：文本 → 终端二维码 */
export function qrTerminal(text) {
  return renderQrTerminal(qrMatrix(text));
}