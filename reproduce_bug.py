
import csv
import sys
from pathlib import Path

ANNOTATION_HEADERS = [
    "pitch",
    "start",
    "end",
    "tonalTechnique",
    "articulation",
    "stringId",
    "position",
    "finger",
    "legato",
]

def test_sync():
    csv_content = """pitch,start,end,tonalTechnique,articulation,stringId,position,finger,legato
69,114.452273,116.006818,,release,,,,0
"""
    csv_path = Path("test_annotation.csv")
    csv_path.write_text(csv_content, encoding="utf-8")

    # Mock midi notes
    midi_notes = [
        {"pitch": 69, "start": 114.452273, "end": 116.006818}
    ]

    # Read existing
    existing_rows = []
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        existing_rows = list(reader)
    
    print("Existing rows read:", existing_rows)

    # Merge logic
    new_rows = []
    count = max(len(midi_notes), len(existing_rows))
    
    fieldnames = list(ANNOTATION_HEADERS)
    if existing_rows:
        existing_keys = set()
        for row in existing_rows:
            existing_keys.update(row.keys())
        for k in existing_keys:
            if k not in fieldnames:
                fieldnames.append(k)
    
    print("Fieldnames:", fieldnames)

    for i in range(count):
        row = {}
        if i < len(existing_rows):
            row = existing_rows[i].copy()
        
        # Ensure all standard headers are present
        for h in ANNOTATION_HEADERS:
            if h not in row:
                row[h] = ""
                
        if i < len(midi_notes):
            note = midi_notes[i]
            if not row.get('pitch'):
                row['pitch'] = str(note['pitch'])
            if not row.get('start'):
                row['start'] = f"{note['start']:.6f}"
            if not row.get('end'):
                row['end'] = f"{note['end']:.6f}"
            
        new_rows.append(row)

    print("New rows:", new_rows)

    # Write back
    output_path = Path("test_output.csv")
    with open(output_path, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(new_rows)
        
    print("Output content:")
    print(output_path.read_text(encoding="utf-8"))

if __name__ == "__main__":
    test_sync()
