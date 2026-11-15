#!/usr/bin/env python3
"""Download authentic global NASA MOLA MEGDR source files for static ARES V6.

Can be run manually before uploading to GitHub Pages or automatically via the
included GitHub Actions workflow. No API keys or extra Python packages needed.
Never generates fake elevations. If a NASA download fails, keep any already
verified local file, and show data-unavailable UI for missing global coverage.
"""
from pathlib import Path
import os
import urllib.request
import time

BASE='https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived'
FILES={
  4:(f'{BASE}/meg004/megt90n000cb.img',1440*720*2),
  16:(f'{BASE}/meg016/megt90n000eb.img',5760*2880*2),
}
ROOT=Path(__file__).resolve().parent.parent
for ppd,(url,required_size) in FILES.items():
    destination=ROOT/f'mola_global_{ppd}ppd.img'
    if destination.exists() and destination.stat().st_size==required_size:
        print(f'Using existing authentic MOLA {ppd} ppd: {destination.name}')
        continue
    tmp=destination.with_suffix('.download')
    succeeded=False
    for attempt in range(2):
        try:
            print(f'Fetching NASA PDS MOLA {ppd} px/degree from {url} (attempt {attempt+1})',flush=True)
            request=urllib.request.Request(url,headers={'User-Agent':'ARES-SpaceApps-2026-V6/1.0'})
            with urllib.request.urlopen(request,timeout=75) as response, open(tmp,'wb') as f:
                while True:
                    data=response.read(1024*1024)
                    if not data:break
                    f.write(data)
            if tmp.stat().st_size!=required_size:
                raise OSError(f'Unexpected file size {tmp.stat().st_size} != {required_size}')
            tmp.replace(destination)
            print(f'Validated and saved {destination.name} ({required_size:,} bytes)',flush=True)
            succeeded=True
            break
        except Exception as exc:
            print(f'NASA PDS download not available: {exc}',flush=True)
            if tmp.exists():tmp.unlink()
            if attempt==0:time.sleep(4)
    if not succeeded:
        print(f'NOTICE: {destination.name} not included. The original Noctis region remains available.')
print('All available authentic global data downloaded; no elevations synthesized.')
