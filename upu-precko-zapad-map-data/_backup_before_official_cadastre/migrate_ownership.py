"""One-off (2026-11-11): moves the ownership records onto the official parcel numbers.

Always starts from _backup_before_official_cadastre/ownership.json, so it can be run again safely.
Run from the repository root:
    python migrate_ownership.py <dir with wb.py> <out ownership.json> <report.json>
"""
import collections
import datetime
import json
import re
import sys
import unicodedata
from fractions import Fraction as F

sys.path.insert(0, sys.argv[1])
from wb import parse  # noqa: E402

D = 'upu-precko-zapad-map-data/'
SRC = D + '_backup_before_official_cadastre/ownership.json'
WBNAME = '061026_ZK DD Prečko.xlsx'
OURS = ['OPATOVINA PROJEKT', 'PROJEKT MAKSIMUS', 'FLAMMULA NEKRETNINE', 'MONERIS NEKRETNINE', 'MATARA NEKRETNINE',
        'AEQUUS NEKRETNINE', 'CURIS NEKRETNINE', 'SIGILLUM NEKRETNINE', 'LANDMARK GROUP']


def key(n):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFC', n).upper()).strip()


def ours(n):
    return any(key(n).startswith(o) for o in OURS)


def num(v):
    return str(int(v)) if float(v).is_integer() else str(v)


now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
W = parse(WBNAME)
src = json.load(open(SRC, encoding='utf-8'))
plots = {f['properties']['id']: f['properties'] for f in json.load(open(D + 'plots.geojson', encoding='utf-8'))['features']}
old = src['plots']
new = {}
rep = collections.OrderedDict()


def from_workbook(k):
    v = W[k]
    sheets = list(v['sheets'])
    agg = collections.OrderedDict()
    for nm, s in v['sheets'][sheets[0]]['owners']:
        nm = re.sub(r'(_x000D_|\s)+', ' ', nm).strip()
        agg.setdefault(key(nm), [nm, F(0)])[1] += F(s)
    our = sum((s for kk, (n, s) in agg.items() if ours(kk)), F(0))
    lines = [
        f'Source: {WBNAME} – sheets {", ".join(sheets)}',
        f'k.o. {next(iter(v["ko"]))} · ZK uložak {next(iter(v["ulozak"]))} · total area {num(next(iter(v["total"])))} m²',
    ]
    ar = [f'{sh} {num(d["area"])} m²' for sh, d in v['sheets'].items() if d['area'] is not None]
    if ar:
        lines.append('Area per kazeta/street (ZK): ' + ', '.join(ar))
    pl = [d['plombe'] for d in v['sheets'].values() if d['plombe']]
    if pl:
        lines.append('Pending registrations (plombe): ' + ', '.join(dict.fromkeys(x.strip() for p in pl for x in re.split(r'[;,]', p))))
    te = [d['tereti'] for d in v['sheets'].values() if d['tereti']]
    if te:
        pairs = list(dict.fromkeys(
            f'{a.strip()} – {b.strip().rstrip(".")}' for a, b in re.findall(r'IZNOS: ([^|\n]+?) \| ZA KORIST: ([^\n]+)', te[0])))
        lines.append('Encumbrances (List C): ' + ('; '.join(pairs) if pairs else re.sub(r'\s*\|\s*', '; ', te[0].strip())))
    return {
        'status': 'owned' if our == 1 else 'not_owned',
        'owners': [{'name': n, 'share': str(s)} for n, s in agg.values()],
        'ourShare': str(our), 'contact': '', 'notes': '\n'.join(lines), 'updatedAt': now,
    }


def clean(rec):
    """Drops the remarks about the old hand-traced shapes."""
    r = dict(rec)
    lines = [ln for ln in r['notes'].split('\n') if not re.match(r'Shape (in \S+ )?traced from the official cadastre', ln)]
    if len(lines) != len(r['notes'].split('\n')):
        r['notes'] = '\n'.join(lines)
        r['updatedAt'] = now
    return r


def with_note(rec, note):
    r = dict(rec)
    r['notes'] = note + '\n' + r['notes']
    r['updatedAt'] = now
    return r


def no_data(note):
    return {'status': 'no_data', 'owners': [], 'ourShare': '', 'contact': '', 'notes': note, 'updatedAt': now}


# official number -> (workbook number, note)
RENAMED = {
    '3676/2': ('3676/1', 'Listed in the workbook as 3676/1 (ZK uložak 565, total area 1216 m², 1235 m² in D4). In the official '
                         'cadastre the parcel with that area and position is 3676/2 – check the plot number in the ZK extract.'),
    '6394/3': ('6394/1', 'Not in the workbook under this number. The workbook counts these 281 m² in M1-7 under 6394/1 '
                         '(ZK uložak 183, shares over 1241 = 815 + 145 + 281 m²), so the owners of 6394/1 are shown here – '
                         'check the ZK extract.'),
}
for n in ('6366/1', '6366/2'):
    RENAMED[n] = ('6366', 'The workbook (6 Oct 2026) lists this land as plot 6366. The cadastre now shows it as 6366/1 and 6366/2 '
                          '(changed 18 Oct 2026). Owners are those the workbook gives for 6366 – check the new ZK extract.')

for k in plots:
    if k in RENAMED:
        wbk, note = RENAMED[k]
        new[k] = with_note(clean(old[wbk]), note)
        rep[k] = f'owners taken from workbook plot {wbk}'
    elif k == '3676/1':
        new[k] = no_data(f'Not in the ZK workbook ({WBNAME}). The workbook row "3676/1" describes the official parcel 3676/2.')
        rep[k] = 'no data (workbook row 3676/1 belongs to 3676/2)'
    elif k in old:
        new[k] = clean(old[k])
        if new[k] != old[k]:
            rep[k] = 'removed the remark about the old hand-traced shape'
    elif k in W:
        new[k] = from_workbook(k)
        rep[k] = 'new record from the workbook: ' + new[k]['status'] + ', ' + '; '.join(f"{o['name']} {o['share']}" for o in new[k]['owners'])
    else:
        new[k] = no_data(f'Not in the ZK workbook ({WBNAME}).')
        rep[k] = 'no data (not in the workbook)'

# Where the workbook's area in a zone clearly belongs to another parcel number today, say so in the notes.
for k, rec in new.items():
    if k not in W or k in RENAMED or k == '3676/1':
        continue
    geo = {z['zone']: z['overlap_m2'] for z in plots[k]['zones']}
    for sh, d in W[k]['sheets'].items():
        if d['area'] is None or sh.startswith('Ulica'):
            continue
        a = geo.get(sh, 0.0)
        if abs(a - d['area']) >= 50:
            rec['notes'] += f'\nBy the official parcel borders (DGU, 11 Nov 2026) this plot has {num(round(a))} m² in {sh}, not {num(d["area"])} m².'
            rec['updatedAt'] = now
            rep[k] = (rep[k] + '; ' if k in rep else '') + f'note added: official area in {sh} is {num(round(a))} m² (workbook {num(d["area"])} m²)'

moved_from = {w for w, _ in RENAMED.values()}
dropped = {k: v for k, v in old.items() if k not in plots and k not in moved_from}
assert all(v['status'] == 'no_data' and not v['owners'] for v in dropped.values()), 'a removed record has data!'

out = {'version': 1, 'savedAt': now, 'plots': new, 'reviews': {}, 'edits': {}}
with open(sys.argv[2], 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
report = {
    'made_at': now,
    'records': len(new),
    'status_counts': dict(collections.Counter(v['status'] for v in new.values())),
    'changes': rep,
    'removed_records_without_official_parcel': sorted(dropped),
    'removed_review_assignments': src['reviews'],
    'removed_border_edits': sorted(src['edits']),
}
with open(sys.argv[3], 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(report, fh, ensure_ascii=False, indent=1)
print('records', len(new), report['status_counts'])
print('removed (no official parcel, all were "no data"):', sorted(dropped))
for k, v in rep.items():
    print(' ', k, '-', v)
