# for i in $(seq -w 1 24); do
#     echo "Checking Paganini_Op01-$(printf "%02d" "$((10#$i))")..."
#     python3 /root/audio-midi-marker/compare_midi_performers.py \
#         --root /mnt/hdd/Violin_Media_Dataset/Paganini \
#         --piece Paganini_Op01-$(printf "%02d" "$((10#$i))") \
#         --prefer-tag trim \
#         # --summary-only
#     echo "================================================"
# done

# # Kayser
# for i in $(seq -w 1 36); do
#     echo "Checking Kayser_Op20-$(printf "%02d" "$((10#$i))")..."
#     python3 /root/audio-midi-marker/compare_midi_performers.py \
#         --root /mnt/hdd/Violin_Media_Dataset/Kayser \
#         --piece Kayser_Op20-$(printf "%02d" "$((10#$i))") \
#         --prefer-tag trim \
#         --summary-only
#     echo "================================================"
# done

# Wohlfahrt
for i in $(seq -w 1 60); do
    echo "Checking Wohlfahrt_Op45-$(printf "%02d" "$((10#$i))")..."
    python3 /root/audio-midi-marker/compare_midi_performers.py \
        --root /mnt/hdd/Violin_Media_Dataset/Wohlfahrt \
        --piece Wohlfahrt_Op45-$(printf "%02d" "$((10#$i))") \
        --prefer-tag trim \
        --summary-only
    echo "================================================"
done
