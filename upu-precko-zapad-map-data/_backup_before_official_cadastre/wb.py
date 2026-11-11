# Parse the ZK workbook: one record per plot number, with owners per sheet.
import openpyxl
from fractions import Fraction as F
def parse(path):
    wb=openpyxl.load_workbook(path,data_only=True); plots={}
    for sh in wb.sheetnames:
        if sh=='KONSOLIDIRANO': continue
        cur=None
        for r in wb[sh].iter_rows(min_row=2,values_only=True):
            a=r[0]
            if a is not None and str(a).strip():
                s=str(a).strip()
                if not s[0].isdigit(): cur=None; continue   # UKUPNO etc.
                cur=s
                p=plots.setdefault(cur,{'ko':set(),'ulozak':set(),'total':set(),'sheets':{}})
                if r[1]: p['ko'].add(str(r[1]).strip())
                if r[2] is not None: p['ulozak'].add(str(r[2]).strip())
                if r[3] is not None: p['total'].add(float(r[3]))
                p['sheets'][sh]={'area':(float(r[4]) if r[4] is not None else None),'owners':[],'plombe':r[8],'tereti':r[9]}
            if cur and r[5] is not None and str(r[5]).strip():
                plots[cur]['sheets'][sh]['owners'].append((str(r[5]).strip(),str(r[6]).strip() if r[6] is not None else ''))
    return plots
if __name__=='__main__':
    import sys,json
    P=parse(sys.argv[1]); print(len(P),'plots')
    for k,v in P.items():
        if len(v['ko'])!=1 or len(v['ulozak'])!=1 or len(v['total'])!=1: print('  inconsistent',k,v['ko'],v['ulozak'],v['total'])
        sets={sh:tuple(sorted(d['owners'])) for sh,d in v['sheets'].items()}
        if len(set(sets.values()))>1: print('  owners differ between sheets',k,sets)
        for sh,d in v['sheets'].items():
            try:
                t=sum(F(s) for _,s in d['owners'])
                if t!=1: print('  shares sum',t,k,sh)
            except Exception as e: print('  bad share',k,sh,d['owners'])
