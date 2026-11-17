# Parses the "*_azurirano.xlsx" workbooks (state per OSS on 16 Nov 2026).
# Returns {plot number: [one entry per workbook row]}; a plot can be in several kazete/streets.
import glob
import os
import re

import openpyxl


def parse(folder='.'):
    plots = {}
    for path in sorted(glob.glob(os.path.join(folder, '*_azurirano.xlsx'))):
        name = os.path.basename(path)
        if name.startswith('~'):  # Excel lock file
            continue
        ws = openpyxl.load_workbook(path).worksheets[0]
        sheet = ws.title.replace('Kazeta ', '')
        cur = entry = None
        # columns B..M: k.č., k.o., ZK uložak, total area, area in kazeta, owner, share, (area by share),
        #               ownership per elaborat, plombe, tereti, napomena
        for b, ko, ul, tot, inz, owner, share, _, elab, plombe, tereti, nap in ws.iter_rows(
                min_row=4, min_col=2, max_col=13, values_only=True):
            if b is not None and str(b).strip():
                s = str(b).strip()
                if not s[0].isdigit():  # UKUPNO
                    cur = None
                    continue
                cur = s
                entry = {'file': name, 'sheet': sheet, 'ko': str(ko).strip(), 'ulozak': str(ul).strip(), 'total': float(tot),
                         'area': float(inz) if inz is not None else None, 'owners': [],
                         'plombe': (plombe or '').strip(), 'tereti': (tereti or '').strip(), 'napomena': (nap or '').strip()}
                plots.setdefault(cur, []).append(entry)
            if cur and owner is not None and str(owner).strip():
                entry['owners'].append((re.sub(r'\s+', ' ', str(owner)).strip(), str(share).strip()))
    return plots
