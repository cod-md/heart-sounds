export function readMovie(bytes) {
    const view = new DataView(bytes);
    const code = (offset, length = 4) => String.fromCharCode(...new Uint8Array(bytes, offset, length));
    const le = code(0) === "XFIR";
    if (!le && code(0) !== "RIFX") throw new Error("Unsupported Director movie.");
    const word = offset => view.getUint16(offset, le);
    const long = offset => view.getUint32(offset, le);
    const map = long(24);
    const count = long(map + 12);
    const entrySize = word(map + 10);
    const table = map + 8 + word(map + 8);
    if (entrySize < 20 || table + count * entrySize > bytes.byteLength) throw new Error("Invalid Director resource map.");
    const chunks = Array.from({ length: count }, (_, index) => {
        const entry = table + index * entrySize;
        return { kind: code(entry), size: long(entry + 4), start: long(entry + 8) + 8 };
    });
    const codeFor = value => le ? [...value].reverse().join("") : value;
    const key = chunks.find(chunk => chunk.kind === codeFor("KEY*"));
    const names = new Map();
    if (key && key.start + key.size <= bytes.byteLength) {
        const keySize = word(key.start + 2);
        if (keySize >= 12) {
            for (let offset = key.start + word(key.start); offset + keySize <= key.start + key.size; offset += keySize) {
                const cast = chunks[long(offset + 4)];
                if (!cast || cast.kind !== codeFor("CASt") || cast.start + cast.size > bytes.byteLength) continue;
                const name = new TextDecoder("windows-1252").decode(new Uint8Array(bytes, cast.start, cast.size));
                const wav = name.match(/[A-Za-z0-9_-]+\.wav/i);
                const label = wav?.[0] ?? name.match(/[\x20-\x7e]{3,}$/)?.[0];
                if (label) names.set(long(offset), label.replace(/\.wav$/i, ""));
            }
        }
    }

    const clips = [];
    const notes = [];
    for (const [id, chunk] of chunks.entries()) {
        if (chunk.start + chunk.size > bytes.byteLength) continue;
        if (chunk.kind === codeFor("STXT") && chunk.size >= 12) {
            const size = view.getUint32(chunk.start + 4);
            if (size > 30 && size <= chunk.size - 12) {
                const data = new Uint8Array(bytes, chunk.start + 12, size);
                notes.push(new TextDecoder("windows-1252").decode(data).replace(/\r\n?/g, "\n").trim());
            }
        }
        if (chunk.kind !== codeFor("snd ") || chunk.size < 78) continue;
        const offset = chunk.start;
        // The Windows movies store Macintosh extended sound headers and big-endian PCM.
        const channels = view.getUint32(offset + 18);
        const frames = view.getUint32(offset + 36);
        const exponent = view.getUint16(offset + 40) - 16383;
        const mantissa = view.getUint32(offset + 42) / 0x80000000;
        const rate = Math.round(mantissa * 2 ** exponent);
        if (view.getUint8(offset + 34) !== 255 || ![1, 2].includes(channels) ||
            !frames || rate < 4000 || rate > 192000 || frames * channels * 2 !== chunk.size - 78) continue;
        clips.push({ id, label: names.get(id) || "Recording " + (clips.length + 1), channels, frames, rate, offset: offset + 78 });
    }
    return { clips, notes, view };
}

export function makeWave({ view }, clip) {
    const length = clip.frames * clip.channels * 2;
    const result = new Uint8Array(44 + length);
    const header = new DataView(result.buffer);
    const ascii = (offset, text) => result.set(new TextEncoder().encode(text), offset);
    ascii(0, "RIFF");
    header.setUint32(4, length + 36, true);
    ascii(8, "WAVEfmt ");
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, clip.channels, true);
    header.setUint32(24, clip.rate, true);
    header.setUint32(28, clip.rate * clip.channels * 2, true);
    header.setUint16(32, clip.channels * 2, true);
    header.setUint16(34, 16, true);
    ascii(36, "data");
    header.setUint32(40, length, true);
    for (let sample = 0; sample < length; sample += 2) {
        header.setInt16(44 + sample, view.getInt16(clip.offset + sample), true);
    }
    return result;
}

