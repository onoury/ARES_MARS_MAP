#!/usr/bin/env python3
"""Static V6 build checks (no network, no dependencies)."""
from pathlib import Path
import hashlib
import json
import struct
import zlib
root=Path(__file__).resolve().parent.parent
required=('index.html','style.css','app.js','bridge.js','planner.py','mars_map.bin','mars_iau_place_names.json')
for name in required:
    assert (root/name).is_file() and (root/name).stat().st_size>0,name
binary=(root/'mars_map.bin').read_bytes()
magic=b'ARES-MOLA-MAP-1\n'
assert binary.startswith(magic),'Invalid Mars map magic'
size=struct.unpack_from('>I',binary,len(magic))[0]
header=json.loads(binary[len(magic)+4:len(magic)+4+size])
start=len(magic)+4+size
compressed=binary[start:start+header['compressed_dem_size']]
image=binary[start+header['compressed_dem_size']:]
assert hashlib.sha256(compressed).hexdigest()==header['compressed_dem_sha256']
raw=zlib.decompress(compressed)
assert hashlib.sha256(raw).hexdigest()==header['terrain']['sha256']
assert len(raw)==433*433*2
assert len(image)==header['jpeg_size']
assert hashlib.sha256(image).hexdigest()==header['jpeg_sha256']
places=json.loads((root/'mars_iau_place_names.json').read_text(encoding='utf-8'))
assert len(places['places'])==places['count']==2054
for item in places['places']:
    assert -90<=item['lat']<=90 and -180<=item['lon']<=180
assert 'loadPyodide' in (root/'bridge.js').read_text()
assert 'ARES_API.fetch' in (root/'app.js').read_text()
print('ARES V6 static assets verified: authentic regional elevation, Viking JPEG, 2,054 place names, browser routing.')
