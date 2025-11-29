#!/bin/bash

# Generate a large wordlist for testing with correct passwords NEAR the end (90% through)
# This ensures hashcat runs long enough to create checkpoints before finding passwords
# Usage: ./generate-wordlist.sh <output_file> <wordlist_size> [test_passwords_file]

OUTPUT_FILE="$1"
WORDLIST_SIZE=${2:-20000}  # Default 20k entries
TEST_PASSWORDS_FILE="${3:-}"

# Calculate where to insert test passwords (90% through the list)
INSERT_POSITION=$((WORDLIST_SIZE * 90 / 100))

echo "Generating wordlist with $WORDLIST_SIZE entries..."
if [ -n "$TEST_PASSWORDS_FILE" ] && [ -f "$TEST_PASSWORDS_FILE" ]; then
    PASS_COUNT=$(wc -l < "$TEST_PASSWORDS_FILE")
    echo "Test passwords ($PASS_COUNT) will be inserted at position $INSERT_POSITION (90% through)"
else
    echo "No test passwords file provided - generating pure decoy wordlist"
fi

# Generate password patterns
counter=0
{
    for i in $(seq 1 $WORDLIST_SIZE); do
        counter=$((counter + 1))

        # At 90% position, insert test passwords
        if [ $counter -eq $INSERT_POSITION ] && [ -n "$TEST_PASSWORDS_FILE" ] && [ -f "$TEST_PASSWORDS_FILE" ]; then
            cat "$TEST_PASSWORDS_FILE"
        fi

        # Generate decoy passwords
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
    done
} > "$OUTPUT_FILE"

ACTUAL_COUNT=$(wc -l < "$OUTPUT_FILE")
echo "Generated wordlist with $ACTUAL_COUNT entries"
echo "Correct passwords are at 90% position to ensure checkpoint testing"
