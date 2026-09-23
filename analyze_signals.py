# -*- coding: utf-8 -*-
"""分析 notices.csv 里可用于「个性化筛选」的信号。"""
import csv
import re
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).resolve().parent
CSV = HERE / "out" / "notices.csv"

rows = []
with open(CSV, encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        rows.append(r)
print(f"总记录: {len(rows)}")

print("\n=== 类别分布 ===")
for k, v in Counter(r["类别"] for r in rows).most_common():
    print(f"  {k:6s} {v}")

print("\n=== 栏目分布（Top 25）===")
for k, v in Counter(r["栏目"] for r in rows).most_common(25):
    print(f"  {v:5d}  {k}")

print("\n=== 栏目归一化（按是否含 学生/教师/研究生/通知/公告）===")
def norm(c):
    if "学生" in c: return "学生类"
    if "教师" in c or "教职工" in c: return "教师类"
    if "研究生" in c: return "研究生类"
    if "招标" in c or "采购" in c: return "招标采购"
    if "招聘" in c or "人才" in c: return "人事招聘"
    if "通知" in c or "公告" in c or "公示" in c: return "通用通知"
    return "其他"
for k, v in Counter(norm(r["栏目"]) for r in rows).most_common():
    print(f"  {k:8s} {v}")

print("\n=== 标题关键词命中数（学生相关）===")
KW = {
    "奖助学金": r"奖学金|助学金|励志|国奖|助学|资助|困难认定|勤工助学|贷款|学费减免|补助",
    "评优评先": r"评优|评先|三好|优秀学生|先进个人|先进班|标兵|综合测评|德育|素质拓展",
    "竞赛科创": r"竞赛|大赛|创新创业|挑战杯|创新创业训练|科研立项|专利|学科竞赛|选拔赛",
    "考试学业": r"考试|补考|重修|缓考|选课|教学安排|四六级|等级考试|期末考试|成绩|学分|培养方案|转专业|学业预警",
    "毕业学位": r"毕业|学位|论文|答辩|结业|推免|保研|学历|证书",
    "党团": r"入党|党员|党课|团日|团学|推优|发展对象|积极分子|团委|学生会|社团|志愿者|社会实践|志愿服务",
    "就业实习": r"就业|招聘|实习|宣讲会|双选会|职业规划|简历|求职",
    "生活服务": r"宿舍|公寓|医保|体检|心理|安全|防诈|校园卡|食堂|图书馆|放假|假期|作息|校历",
}
for k, pat in KW.items():
    n = sum(1 for r in rows if re.search(pat, r["标题"]))
    print(f"  {k:8s} {n}")

print("\n=== 标题里出现「学生」/「本科生」/「研究生」的次数 ===")
for k in ("学生", "本科生", "研究生", "全体", "各学院", "团员", "党员", "班级"):
    n = sum(1 for r in rows if k in r["标题"])
    print(f"  {k:6s} {n}")

print("\n=== 标题里出现年级/年份限定的样例 ===")
pat = re.compile(r"20\d{2}级|大[一二三四]|研[一二三]|毕业班|应届|新生")
hits = [r for r in rows if pat.search(r["标题"])]
print(f"命中 {len(hits)} 条，样例：")
for r in hits[:12]:
    print(f"  [{r['发布日期']}] {r['标题'][:58]}")
