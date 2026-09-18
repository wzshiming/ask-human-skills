const EC_PER_BLOCK = [
  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30,
  30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
];
const BLOCK_COUNT = [
  1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19,
  20, 21, 22, 24, 25,
];

function totalCodewords(version) {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const positions = Math.floor(version / 7) + 2;
    modules -= (25 * positions - 10) * positions - 55;
    if (version >= 7) modules -= 36;
  }
  return Math.floor(modules / 8);
}

function dataCodewords(version) {
  return totalCodewords(version) - EC_PER_BLOCK[version - 1] * BLOCK_COUNT[version - 1];
}

function multiply(left, right) {
  let product = 0;
  while (right !== 0) {
    if (right & 1) product ^= left;
    right >>>= 1;
    left <<= 1;
    if (left & 0x100) left ^= 0x11d;
  }
  return product;
}

function generatorPolynomial(degree) {
  let polynomial = [1];
  let root = 1;
  for (let index = 0; index < degree; index++) {
    const next = Array(polynomial.length + 1).fill(0);
    for (let term = 0; term < polynomial.length; term++) {
      next[term] ^= polynomial[term];
      next[term + 1] ^= multiply(polynomial[term], root);
    }
    polynomial = next;
    root = multiply(root, 2);
  }
  return polynomial;
}

function interleave(data, version) {
  const count = BLOCK_COUNT[version - 1];
  const degree = EC_PER_BLOCK[version - 1];
  const shortLength = Math.floor(data.length / count);
  const shortCount = count - (data.length % count);
  const generator = generatorPolynomial(degree);
  const blocks = [];
  const corrections = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const length = shortLength + Number(index >= shortCount);
    const block = data.slice(offset, offset + length);
    offset += length;
    const remainder = [...block, ...Array(degree).fill(0)];
    for (let position = 0; position < length; position++) {
      const factor = remainder[position];
      for (let term = 0; term < generator.length; term++) {
        remainder[position + term] ^= multiply(generator[term], factor);
      }
    }
    blocks.push(block);
    corrections.push(remainder.slice(length));
  }
  const result = [];
  for (let position = 0; position <= shortLength; position++) {
    for (const block of blocks) {
      if (position < block.length) result.push(block[position]);
    }
  }
  for (let position = 0; position < degree; position++) {
    for (const correction of corrections) result.push(correction[position]);
  }
  return result;
}

function encode(bytes, version) {
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  const append = (value, length) => {
    for (let shift = length - 1; shift >= 0; shift--) bits.push((value >>> shift) & 1);
  };
  append(4, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let offset = 0; offset < bits.length; offset += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) | bits[offset + bit];
    data.push(value);
  }
  let pad = 0xec;
  while (data.length < capacity / 8) {
    data.push(pad);
    pad ^= 0xec ^ 0x11;
  }
  return interleave(data, version);
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const last = 4 * version + 10;
  const step = version === 32 ? 26 : Math.ceil((last - 6) / (2 * (count - 1))) * 2;
  const positions = [6];
  for (let index = count - 2; index >= 0; index--) positions.push(last - index * step);
  return positions;
}

function bch(value, shift, polynomial) {
  let remainder = value << shift;
  const degree = 31 - Math.clz32(polynomial);
  while (remainder !== 0 && 31 - Math.clz32(remainder) >= degree) {
    remainder ^= polynomial << (31 - Math.clz32(remainder) - degree);
  }
  return (value << shift) | remainder;
}

function drawPatterns(version, size, set) {
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let row = -1; row <= 7; row++) {
      for (let col = -1; col <= 7; col++) {
        const inside = row >= 0 && row <= 6 && col >= 0 && col <= 6;
        const edge = row === 0 || row === 6 || col === 0 || col === 6;
        const center = row >= 2 && row <= 4 && col >= 2 && col <= 4;
        set(top + row, left + col, Number(inside && (edge || center)));
      }
    }
  }
  for (let index = 8; index < size - 8; index++) {
    set(6, index, Number(index % 2 === 0));
    set(index, 6, Number(index % 2 === 0));
  }
  const positions = alignmentPositions(version);
  const last = size - 7;
  for (const row of positions) {
    for (const col of positions) {
      if ((row === 6 && (col === 6 || col === last)) || (row === last && col === 6)) continue;
      for (let down = -2; down <= 2; down++) {
        for (let across = -2; across <= 2; across++) {
          set(row + down, col + across, Number(Math.max(Math.abs(down), Math.abs(across)) !== 1));
        }
      }
    }
  }

  const format = bch(8, 10, 0x537) ^ 0x5412;
  const formatBit = index => (format >>> index) & 1;
  for (let index = 0; index < 6; index++) set(index, 8, formatBit(index));
  set(7, 8, formatBit(6));
  set(8, 8, formatBit(7));
  set(8, 7, formatBit(8));
  for (let index = 9; index < 15; index++) set(8, 14 - index, formatBit(index));
  for (let index = 0; index < 8; index++) set(8, size - 1 - index, formatBit(index));
  for (let index = 8; index < 15; index++) set(size - 15 + index, 8, formatBit(index));
  set(size - 8, 8, 1);
  if (version >= 7) {
    const information = bch(version, 12, 0x1f25);
    for (let index = 0; index < 18; index++) {
      const row = Math.floor(index / 3);
      const col = size - 11 + (index % 3);
      const bit = (information >>> index) & 1;
      set(row, col, bit);
      set(col, row, bit);
    }
  }
}

export function qrMatrix(text) {
  const bytes = Buffer.from(text, 'utf8');
  let version = 1;
  while (version <= 40) {
    const required = 4 + (version < 10 ? 8 : 16) + bytes.length * 8;
    if (required <= dataCodewords(version) * 8) break;
    version++;
  }
  if (version > 40) throw new Error('QR text exceeds the 2953-byte level-L capacity');
  const codewords = encode(bytes, version);
  const size = 17 + 4 * version;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (row, col, value) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    matrix[row][col] = value;
    reserved[row][col] = true;
  };
  drawPatterns(version, size, set);

  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let offset = 0; offset < size; offset++) {
      const row = upward ? size - 1 - offset : offset;
      for (let side = 0; side < 2; side++) {
        const col = right - side;
        if (reserved[row][col]) continue;
        const byte = codewords[Math.floor(bitIndex / 8)] ?? 0;
        const bit = (byte >>> (7 - (bitIndex % 8))) & 1;
        matrix[row][col] = bit ^ Number((row + col) % 2 === 0);
        bitIndex++;
      }
    }
    upward = !upward;
  }
  return matrix;
}

export function renderQr(matrix) {
  const size = matrix.length + 8;
  const glyphs = [' ', '\u2584', '\u2580', '\u2588'];
  const lines = [];
  for (let row = 0; row < size; row += 2) {
    let content = '';
    for (let col = 0; col < size; col++) {
      const top = matrix[row - 4]?.[col - 4] ?? 0;
      const bottom = matrix[row - 3]?.[col - 4] ?? 0;
      content += glyphs[top * 2 + bottom];
    }
    lines.push(`\x1b[30;107m${content}\x1b[0m`);
  }
  return lines.join('\n') + '\n';
}
