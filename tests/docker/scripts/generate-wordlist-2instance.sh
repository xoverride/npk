#!/bin/bash

# Generate a wordlist for 2-instance testing with passwords split between instances
# NPK splits keyspace: limit = ceil(total / instance_count)
# For a 20,000 entry wordlist:
# Instance 1: skip=0, limit=ceil(20000/2)=10,000 → entries 0-9,999
# Instance 2: skip=10,000, no limit → entries 10,000-19,999
# Usage: ./generate-wordlist-2instance.sh <output_file> <wordlist_size> <passwords_file_1> <passwords_file_2>

OUTPUT_FILE="$1"
WORDLIST_SIZE=${2:-20000}
PASSWORDS_FILE_1="$3"  # Passwords for instance 1 (2 passwords)
PASSWORDS_FILE_2="$4"  # Passwords for instance 2 (2 passwords)

# Calculate split point (how NPK divides keyspace)
SPLIT_POINT=$((WORDLIST_SIZE / 2))

# Place passwords at 40% (in instance 1's range) and 75% (in instance 2's range)
# Positions are 0-indexed, so subtract 1
POSITION_INST1_START=$((WORDLIST_SIZE * 40 / 100))  # 40% = 8,000 (line 8,001 in 1-indexed)
POSITION_INST2_START=$((WORDLIST_SIZE * 75 / 100))  # 75% = 15,000 (line 15,001 in 1-indexed)

echo "Generating wordlist with exactly $WORDLIST_SIZE entries for 2-instance test..."
echo "Keyspace split at entry $SPLIT_POINT"
echo "Instance 1 (entries 0-$((SPLIT_POINT-1))) passwords at entries $POSITION_INST1_START-$((POSITION_INST1_START+1))"
echo "Instance 2 (entries $SPLIT_POINT-$((WORDLIST_SIZE-1))) passwords at entries $POSITION_INST2_START-$((POSITION_INST2_START+1))"

# Read test passwords into arrays (portable way without mapfile)
PASSWORDS_1=()
if [ -f "$PASSWORDS_FILE_1" ]; then
    while IFS= read -r line; do
        PASSWORDS_1+=("$line")
    done < "$PASSWORDS_FILE_1"
    echo "DEBUG: Read ${#PASSWORDS_1[@]} passwords from Instance 1 file" >&2
    for idx in "${!PASSWORDS_1[@]}"; do
        echo "DEBUG:   PASSWORDS_1[$idx] = '${PASSWORDS_1[$idx]}'" >&2
    done
fi

PASSWORDS_2=()
if [ -f "$PASSWORDS_FILE_2" ]; then
    while IFS= read -r line; do
        PASSWORDS_2+=("$line")
    done < "$PASSWORDS_FILE_2"
    echo "DEBUG: Read ${#PASSWORDS_2[@]} passwords from Instance 2 file" >&2
    for idx in "${!PASSWORDS_2[@]}"; do
        echo "DEBUG:   PASSWORDS_2[$idx] = '${PASSWORDS_2[$idx]}'" >&2
    done
fi

# Generate wordlist with exactly WORDLIST_SIZE entries
{
    for i in $(seq 0 $((WORDLIST_SIZE-1))); do
        # Check if this position should have a test password
        if [ $i -eq $POSITION_INST1_START ] && [ ${#PASSWORDS_1[@]} -gt 0 ]; then
            # First password for instance 1
            echo "${PASSWORDS_1[0]}"
        elif [ $i -eq $((POSITION_INST1_START+1)) ] && [ ${#PASSWORDS_1[@]} -gt 1 ]; then
            # Second password for instance 1
            echo "${PASSWORDS_1[1]}"
        elif [ $i -eq $POSITION_INST2_START ] && [ ${#PASSWORDS_2[@]} -gt 0 ]; then
            # First password for instance 2
            echo "${PASSWORDS_2[0]}"
        elif [ $i -eq $((POSITION_INST2_START+1)) ] && [ ${#PASSWORDS_2[@]} -gt 1 ]; then
            # Second password for instance 2
            echo "${PASSWORDS_2[1]}"
        else
            # Generate decoy password
            case $((i % 10)) in
                0) echo "test${i}pass" ;;
                1) echo "user${i}@2024" ;;
                2) echo "admin${i}123" ;;
                3) echo "demo${i}pwd" ;;
                4) echo "sample${i}key" ;;
                5) echo "random${i}str" ;;
                6) echo "fake${i}pass" ;;
                7) echo "wrong${i}pwd" ;;
                8) echo "invalid${i}" ;;
                9) echo "notcorrect${i}" ;;
            esac
        fi
    done
} > "$OUTPUT_FILE"

ACTUAL_COUNT=$(wc -l < "$OUTPUT_FILE")
echo "Generated wordlist with $ACTUAL_COUNT entries"
echo "Instance 1 passwords at entries $POSITION_INST1_START-$((POSITION_INST1_START+1)) (in range 0-$((SPLIT_POINT-1)))"
echo "Instance 2 passwords at entries $POSITION_INST2_START-$((POSITION_INST2_START+1)) (in range $SPLIT_POINT-$((WORDLIST_SIZE-1)))"
