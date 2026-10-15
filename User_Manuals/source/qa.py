import re,subprocess,collections
R=['Tachometer','Critical Number','Revenue Trend','Invoices Engine','Customer Growth','Pipeline Health','Pipeline Trend','Activity Momentum','MARCOM Spending','Media Campaign Performance','Digital Performance','Trade Marketing','Stock Velocity','Product Lifecycle','BCG','PIM']
BAD=['Admin Panel','Data Quality','Upload data','Tasks','Task:','المهام','مهمة:','/Dashboard/Dashboard','change-password','Change password page']
def txt(n): return subprocess.run(['pdftotext',f'out/{n}.pdf','-'],capture_output=True,text=True).stdout
def html(n): return open(f'out/{n}.html',encoding='utf8').read()
for n in ['Manual_FullAccess_EN','Manual_FullAccess_AR','Manual_Salesperson_EN','Manual_Salesperson_AR']:
    t=txt(n); h=html(n)
    miss=[r for r in R if r not in t]; bad=[b for b in BAD if b in t]
    print(n,'| reports present',16-len(miss),'missing',miss if 'Full' in n else '', '| bad',bad, '| admin chip', 'shots/header.png' in h and 'Sales' in n)
    if 'Sales' in n: print('   restricted in sales:',[r for r in R[1:] if r in t])
    c=collections.Counter(re.findall(r'<(h1|h2|h3|figure|table|tr|li)[ >]',h)); c['callout']=h.count('class="callout'); print('  ',dict(sorted(c.items())))
    print('   dashboard urls:',set(re.findall(r'https?://dashboards\.benmussaholding\.com[^\s<"\)]*',h)))
