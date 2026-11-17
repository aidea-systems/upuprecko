"""One-off (2026-11-17): updates the ownership records from the "*_azurirano.xlsx" workbooks
(state per OSS, oss.uredjenazemlja.hr, on 16 Nov 2026: D4, M1-2, M1-4, M1-6, M2-1, M2-3, Ulica 1B, Ulica 3).

Always starts from _backup_before_oss_update/ownership.json, so it can be run again safely.
Run from the repository root:
    python upu-precko-zapad-map-data/_backup_before_oss_update/update_ownership_oss.py <out ownership.json> <report.json>

Rules (same as the first import):
- "us" = the Opatovina group (app/src/config.ts ourOwners); 100 % ours -> owned, otherwise not_owned
  (a status "negotiating" set by hand is kept while the plot is not fully ours);
- several register parts of one owner are added up; the parts are listed in the notes;
- records of plots that are not in these workbooks are not touched (except 3676/2, 6366/1, 6367/1, see below).
"""
import collections
import datetime
import json
import os
import re
import sys
import unicodedata
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from oss_wb import parse  # noqa: E402

D = 'upu-precko-zapad-map-data/'
SRC = os.path.join(HERE, 'ownership.json')
OLD_WB = '061026_ZK DD Prečko.xlsx'
OSS = 'OSS (oss.uredjenazemlja.hr), state on 16 Nov 2026'
OURS = ['OPATOVINA PROJEKT', 'PROJEKT MAKSIMUS', 'FLAMMULA NEKRETNINE', 'MONERIS NEKRETNINE', 'MATARA NEKRETNINE',
        'AEQUUS NEKRETNINE', 'CURIS NEKRETNINE', 'SIGILLUM NEKRETNINE', 'LANDMARK GROUP']


def key(n):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFC', n).upper()).strip()


def ours(n):
    return any(key(n).startswith(o) for o in OURS)


def num(v):
    return str(int(v)) if float(v).is_integer() else str(v)


def agg(pairs):
    out = collections.OrderedDict()
    for n, s in pairs:
        out[key(n)] = out.get(key(n), F(0)) + F(s)
    return out


now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
W = parse('.')
src = json.load(open(SRC, encoding='utf-8'))
geo = {f['properties']['id']: f['properties'] for f in json.load(open(D + 'plots.geojson', encoding='utf-8'))['features']}
old = src['plots']
new = {k: dict(v) for k, v in old.items()}
changes = collections.OrderedDict()
warnings = []

# spelling of an owner already used in the data (e.g. "OPATOVINA PROJEKT d.o.o."), so one owner keeps one spelling
spell = collections.defaultdict(collections.Counter)
for r in old.values():
    for o in r['owners']:
        spell[key(o['name'])][o['name']] += 1


def spelled(n):
    c = spell.get(key(n))
    return c.most_common(1)[0][0] if c else n


def note_lines(rec, prefix):
    return [ln for ln in rec['notes'].split('\n') if ln.startswith(prefix)]


def expand(t):
    t = re.sub(r'\bpodzal\.', 'podzaložno pravo', t)
    t = re.sub(r'\bzal\.', 'založno pravo', t)
    return re.sub(r'\bust\.', 'ustupljeno', t)


def none_or(v):
    return 'none' if v.upper() in ('', 'NEMA') else v


def same_owners(rec, es):
    try:
        cur = agg((o['name'], o['share']) for o in rec['owners'])
    except (ValueError, ZeroDivisionError):
        return False
    nw = agg(es[0]['owners'])
    if cur == nw:
        return True
    # the City of Zagreb written in different words
    return (len(cur) == 1 and len(nw) == 1 and 'GRAD ZAGREB' in next(iter(cur)) and 'GRAD ZAGREB' in next(iter(nw))
            and next(iter(cur.values())) == next(iter(nw.values())) == 1)


def build(k, es, lead=()):
    """New record for plot k from its workbook rows es (identical owners in every row - checked below)."""
    rec = old[k]
    e = es[0]
    g = geo[k]
    a = agg(e['owners'])
    names = {}
    for n, _ in e['owners']:
        names.setdefault(key(n), spelled(n))
    our = sum((s for kk, s in a.items() if ours(kk)), F(0))
    unchanged = same_owners(rec, es)
    owners = rec['owners'] if unchanged else [{'name': names[kk], 'share': str(s)} for kk, s in a.items()]
    status = 'owned' if our == 1 else ('negotiating' if rec['status'] == 'negotiating' else 'not_owned')

    lines = list(lead)
    lines.append(f'Source: {OSS} – ' + ', '.join(dict.fromkeys(x['file'] for x in es)))
    m = [ln for ln in note_lines(rec, 'Source: ') if OLD_WB in ln]
    if m:
        lines.append('Earlier source: ' + m[0][len('Source: '):].replace(' – sheets', ' (6 Oct 2026) – sheets'))
    lines.append(f'k.o. {g["municipality"]} · ZK uložak {e["ulozak"]} · total area {num(e["total"])} m²')
    # area per kazeta/street: the earlier list, with the values of the updated sheets
    areas = collections.OrderedDict()
    m = note_lines(rec, 'Area per kazeta/street (ZK): ')
    if m and not lead:
        for sh, v in re.findall(r'([^,]+?) ([\d.]+) m²', m[0].split(': ', 1)[1]):
            areas[sh.strip()] = float(v)
    newa = collections.OrderedDict()
    for x in es:
        if x['area'] is not None:
            newa[x['sheet']] = newa.get(x['sheet'], 0) + x['area']
    for sh, v in newa.items():
        hit = next((o for o in areas if o.lower() == sh.lower()), sh)
        areas[hit] = v
    if areas:
        lines.append('Area per kazeta/street (ZK): ' + ', '.join(f'{sh} {num(v)} m²' for sh, v in areas.items()))
    parts = collections.OrderedDict()
    for n, s in e['owners']:
        parts.setdefault(key(n), []).append(s)
    multi = [f'{names[kk]} {" + ".join(p)}' for kk, p in parts.items() if len(p) > 1]
    if multi:
        lines.append('Co-ownership parts in the land register: ' + '; '.join(multi))
    lines.append('Pending registrations (plombe): ' + none_or(e['plombe']))
    lines.append('Encumbrances (List C): ' + none_or(expand(e['tereti'])))
    if e['napomena']:
        lines.append('Workbook remark: ' + e['napomena'])
    if not unchanged and rec['owners']:
        lines.append(f'Owners before this update ({OLD_WB}, 6 Oct 2026): ' + '; '.join(f"{o['name']} {o['share']}" for o in rec['owners']))
    # where the workbook's area in a zone clearly differs from the official borders
    zs = {z['zone']: z['overlap_m2'] for z in g['zones']}
    for sh, v in newa.items():
        if not sh.startswith('Ulica') and abs(zs.get(sh, 0.0) - v) >= 50:
            lines.append(f'By the official parcel borders (DGU, 11 Nov 2026) this plot has {num(round(zs.get(sh, 0.0)))} m² in {sh}, not {num(v)} m².')
    for ln in note_lines(rec, 'By the official parcel borders'):
        if not lead and not any(f' in {sh}, ' in ln for sh in newa):
            lines.append(ln)
    out = {'status': status, 'owners': owners, 'ourShare': str(our), 'contact': rec['contact'], 'notes': '\n'.join(lines), 'updatedAt': now}

    what = []
    if not unchanged:
        what.append('owners: ' + ('; '.join(f"{o['name']} {o['share']}" for o in rec['owners']) or '(none)') + '  ->  '
                    + '; '.join(f"{o['name']} {o['share']}" for o in owners))
    if rec['ourShare'] != out['ourShare']:
        what.append(f"our share {rec['ourShare'] or '(empty)'} -> {out['ourShare']}")
    if rec['status'] != status:
        what.append(f"status {rec['status']} -> {status}")
    m = re.search(r'ZK uložak (\S+)', rec['notes'])
    if m and m.group(1) != e['ulozak']:
        what.append(f"ZK uložak {m.group(1)} -> {e['ulozak']}")
    changes[k] = '; '.join(what) if what else 'owners unchanged; pending registrations / encumbrances refreshed'
    return out


for k, es in W.items():
    if k not in geo:
        warnings.append(f'{k}: in the workbooks but not an official parcel on the map - skipped')
        continue
    for fld in ('ko', 'ulozak', 'total', 'owners', 'plombe', 'tereti', 'napomena'):
        if len({json.dumps(x[fld], ensure_ascii=False) for x in es}) > 1:
            warnings.append(f'{k}: "{fld}" differs between ' + ', '.join(x['sheet'] for x in es) + ' - first one used')
    t = sum((F(s) for _, s in es[0]['owners']), F(0))
    if t != 1:
        warnings.append(f'{k}: owner shares add up to {t}, not 1')
    if geo[k].get('registered_area_m2') != es[0]['total']:
        warnings.append(f'{k}: total area {num(es[0]["total"])} m² in the workbook, {num(geo[k].get("registered_area_m2"))} m² in the cadastre')
    if key(geo[k]['municipality']) != key(es[0]['ko']):
        warnings.append(f'{k}: k.o. {es[0]["ko"]} in the workbook, {geo[k]["municipality"]} in the cadastre')
    lead = ()
    if k == '3676/1':
        lead = ('The workbook counts 1235 m² of this plot in D4. By the official parcel borders that land is plot 3676/2; '
                '3676/1 (1348 m²) lies next to it, almost entirely outside the UPU.',)
    elif k == '6366/2':
        lead = ('Part of the former plot 6366 (split in the cadastre on 18 Oct 2026; the other part is 6366/1).',)
    elif k == '6367/2':
        lead = ('Part of the former plot 6367 (the other part is 6367/1).',)
    new[k] = build(k, es, lead)

# --- plots that are not a row in the new workbooks but are affected by them
r = dict(old['3676/2'])
keep = [ln for ln in r['notes'].split('\n') if not ln.startswith('Listed in the workbook as 3676/1')]
r['notes'] = '\n'.join([
    f'Not checked in the update of 16 Nov 2026. The workbook of 6 Oct 2026 lists this land (1235 m² in D4) as "3676/1" with '
    'ZK uložak 565 and total area 1216 m² – in the official cadastre that is plot 3676/2. The updated D4 workbook describes the '
    'real 3676/1 (ZK uložak 122, 1348 m², Jurendić Danica) but still counts the 1235 m² in D4 under it. '
    'Owner shown here is from the 6 Oct 2026 workbook – check the ZK extract for 3676/2.'] + keep)
r['updatedAt'] = now
new['3676/2'] = r
changes['3676/2'] = 'owners not changed (not checked on 16 Nov 2026); note rewritten'

r = dict(old['6366/1'])
prev = '; '.join(f"{o['name']} {o['share']}" for o in r['owners'])
r.update(status='not_owned', ourShare='0', updatedAt=now,
         owners=[{'name': spelled('SOMEK KRISTINA'), 'share': ''}, {'name': spelled('SOMEK DAMIR'), 'share': ''}],
         notes='\n'.join([
             'Part of the former plot 6366 (split in the cadastre on 18 Oct 2026; the other part is 6366/2).',
             f'Source: {OSS} – remark on plot 6366/2 in Kazeta_M1-6_azurirano.xlsx: "k.č. 6366/1 (ZK ul. 12073) su Somek Kristina i Damir". '
             'The workbook has no row for this plot, so the shares of the two owners are not known (left empty).',
             f'k.o. {geo["6366/1"]["municipality"]} · ZK uložak 12073 · total area {num(geo["6366/1"]["registered_area_m2"])} m² (cadastre)',
             f'Owners before this update ({OLD_WB}, 6 Oct 2026, as plot 6366): {prev}']))
new['6366/1'] = r
changes['6366/1'] = f'owners: {prev}  ->  Somek Kristina, Somek Damir (shares not stated); our share 67/1548 -> 0; from the remark on 6366/2'

r = dict(old['6367/1'])
prev = '; '.join(f"{o['name']} {o['share']}" for o in r['owners'])
r.update(status='not_owned', ourShare='0', updatedAt=now, owners=[{'name': spelled('MARTINEC DRAGUTIN'), 'share': '1'}],
         notes='\n'.join([
             'Part of the former plot 6367 (the other part is 6367/2).',
             f'Source: {OSS} – remark on plot 6367/2 in Kazeta_M1-6_azurirano.xlsx: "k.č. 6367/1 (ZK ul. 12071) je Martinec Dragutin". '
             'The workbook has no row for this plot.',
             f'k.o. {geo["6367/1"]["municipality"]} · ZK uložak 12071 · total area {num(geo["6367/1"]["registered_area_m2"])} m² (cadastre)',
             f'Owners before this update ({OLD_WB}, 6 Oct 2026): {prev}']))
new['6367/1'] = r
changes['6367/1'] = f'owners: {prev}  ->  Martinec Dragutin 1; our share 75/1471 -> 0; from the remark on 6367/2'


def zone_pct(recs):
    tot = collections.defaultdict(float)
    our = collections.defaultdict(float)
    for k, g in geo.items():
        r = recs.get(k)
        sh = float(F(r['ourShare'])) if r and r['ourShare'] else (1.0 if r and r['status'] == 'owned' else 0.0)
        for z in g['zones']:
            tot[z['zone']] += z['overlap_m2']
            our[z['zone']] += z['overlap_m2'] * sh
    return {z: round(100 * our[z] / tot[z], 1) for z in sorted(tot)}


before, after = zone_pct(old), zone_pct(new)
out = dict(src, savedAt=now, plots=new)
with open(sys.argv[1], 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
report = {
    'made_at': now,
    'workbook_plots': len(W),
    'records_touched': len(changes),
    'status_counts_before': dict(collections.Counter(v['status'] for v in old.values())),
    'status_counts_after': dict(collections.Counter(v['status'] for v in new.values())),
    'zone_percent_owned_by_area': {z: {'before': before[z], 'after': after[z]} for z in after if before[z] != after[z]},
    'warnings': warnings,
    'changes': changes,
}
with open(sys.argv[2], 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(report, fh, ensure_ascii=False, indent=1)
sys.stdout.reconfigure(encoding='utf-8')
print('touched', len(changes), 'of', len(new), 'records;', report['status_counts_before'], '->', report['status_counts_after'])
print('zone % owned by area (changed):', report['zone_percent_owned_by_area'])
print('warnings:', *warnings, sep='\n  ')
for k, v in changes.items():
    if not v.startswith('owners unchanged'):
        print(' ', k, '-', v)
print('owners unchanged, notes refreshed:', sum(v.startswith('owners unchanged') for v in changes.values()))
