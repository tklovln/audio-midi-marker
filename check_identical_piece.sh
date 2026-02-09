# for i in $(seq -w 1 24); do
#     python3 /root/audio-midi-marker/compare_midi_performers.py \
#         --root /mnt/hdd/violin_media_outputs/Paganini \
#         --piece Paganini_Op01-$(printf "%02d" "$((10#$i))") \
#         --prefer-tag trim \
#         --mismatch-context 6 \
#         --summary-only
# done

python3 /root/audio-midi-marker/compare_midi_performers.py \
        --root /mnt/hdd/violin_media_outputs/Paganini \
        --piece Paganini_Op01-23-a \
        --prefer-tag trim \
        --mismatch-context 6 \
        --summary-only

