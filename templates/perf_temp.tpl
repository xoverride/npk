# ===============================

# Use this to generate benchmarks
# /root/hashcat/hashcat.bin -O -w 4 -b --benchmark-all | tee /potfiles/benchmark-results.txt
# aws --region $USERDATAREGION s3 cp /potfiles/benchmark-results.txt s3://$USERDATA/$ManifestPath/potfiles/

# poweroff
# ===============================

# Use this to generate wordlist benchmarks
# aws s3 cp s3://$BUCKET/components-v3/hashstash.7z .
# 7z x hashstash.7z
# ls hashstash | awk ' { system("./hashcat/hashcat.bin -O -w 4 --keep-guessing --runtime 20 -m " $1 " -a 0 -r npk-rules/npk-maskprocessor.rule -r npk-rules/OneRuleToRuleThemAll.rule ./hashstash/" $1 " ./npk-wordlist/rockyou.txt | grep -e Speed.# -e Hash.Mode | tee -a /potfiles/wordlist-benchmark-results.txt") } '
# aws --region $USERDATAREGION s3 cp /potfiles/wordlist-benchmark-results.txt s3://$USERDATA/$ManifestPath/potfiles/

# poweroff
# ===============================
