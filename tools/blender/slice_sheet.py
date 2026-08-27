#!/usr/bin/env python3
"""Slice the Nyx pose sheet into individual reference tiles.

usage: python3 tools/blender/slice_sheet.py <sheet.png> <out_dir> [cols] [rows]

The sheet is a regular grid with a caption strip under each tile. Tiles are cut
on the grid and the caption band is trimmed off the bottom, so each output is
just the character — which is what a side-by-side comparison needs.
"""
import sys, os, struct, zlib

def read_png(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit('not a PNG: ' + path)
    pos, w, h, idat, bitd, ctype = 8, 0, 0, b'', 8, 6
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos+4])[0]
        typ = data[pos+4:pos+8]
        body = data[pos+8:pos+8+ln]
        if typ == b'IHDR':
            w, h, bitd, ctype = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
        pos += 12 + ln
    if bitd != 8 or ctype not in (2, 6):
        raise SystemExit(f'need 8-bit RGB/RGBA, got bitdepth={bitd} colortype={ctype}')
    ch = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    stride = w * ch
    out = bytearray(w * h * ch)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if ft == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i-ch]) & 255
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif ft == 3:
            for i in range(stride):
                a = line[i-ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif ft == 4:
            for i in range(stride):
                a = line[i-ch] if i >= ch else 0
                b = prev[i]
                c = prev[i-ch] if i >= ch else 0
                pa, pb, pc = abs(b-c), abs(a-c), abs(a+b-2*c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y*stride:(y+1)*stride] = line
        prev = line
    return w, h, ch, out

def write_png(path, w, h, ch, px):
    stride = w * ch
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y*stride:(y+1)*stride]
    comp = zlib.compress(bytes(raw), 6)
    def chunk(t, b):
        return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2 if ch == 3 else 6, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', comp) + chunk(b'IEND', b''))

NAMES = ['01_idle', '02_ready', '03_pushing_off', '04_riding_forward', '05_carving_left',
         '06_carving_right', '07_crouching', '08_braking', '09_jump_takeoff', '10_airborne_straight',
         '11_spin_setup', '12_spin_midair', '13_grab_method', '14_grab_indy', '15_rail_grind',
         '16_landing', '17_celebrating', '18_turning_backward', '19_wipeout', '20_trick_finish']

def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    src, out = sys.argv[1], sys.argv[2]
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    rows = int(sys.argv[4]) if len(sys.argv) > 4 else 4
    w, h, ch, px = read_png(src)
    tw, th = w // cols, h // rows
    CAPTION = 0.13          # bottom fraction of each tile that is the label strip
    keep = int(th * (1 - CAPTION))
    os.makedirs(out, exist_ok=True)
    n = 0
    for r in range(rows):
        for c in range(cols):
            tile = bytearray(tw * keep * ch)
            for y in range(keep):
                sy = r * th + y
                s = (sy * w + c * tw) * ch
                tile[y*tw*ch:(y+1)*tw*ch] = px[s:s + tw*ch]
            name = NAMES[n] if n < len(NAMES) else f'{n+1:02d}_pose'
            write_png(os.path.join(out, name + '.png'), tw, keep, ch, tile)
            n += 1
    print(f'[slice] {n} tiles at {tw}x{keep} -> {out}')

main()
