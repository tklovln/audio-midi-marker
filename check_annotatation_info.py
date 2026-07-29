#!/usr/bin/env python3
import os
import csv
import json
from collections import Counter
from pathlib import Path
import sys

def analyze_annotations(data_dir):
    print(f"Analyzing data in: {data_dir}")
    
    total_notes = 0
    pitch_counter = Counter()
    tonal_technique_counter = Counter()
    articulation_counter = Counter()
    legato_counter = Counter()
    
    files_with_float_legato = set()
    files_with_none_legato = set()
    
    annotation_files = []
    
    # Find all annotation_revised.csv files
    for root, dirs, files in os.walk(data_dir):
        if "annotation_revised.csv" in files:
            status_path = os.path.join(root, "status.json")
            if os.path.exists(status_path):
                try:
                    with open(status_path, 'r', encoding='utf-8') as sf:
                        status_data = json.load(sf)
                        if status_data.get("completed") is True:
                            annotation_files.append(os.path.join(root, "annotation_revised.csv"))
                except json.JSONDecodeError:
                    print(f"Error decoding JSON in {status_path}")
                except Exception as e:
                    print(f"Error reading {status_path}: {e}")
            
    print(f"Found {len(annotation_files)} annotation_revised.csv files with completed status.")
    
    for file_path in annotation_files:
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    total_notes += 1
                    
                    # Pitch
                    pitch_str = row.get('pitch', '').strip()
                    if pitch_str:
                        # Try to normalize pitch to integer if it looks like one
                        try:
                            pitch_val = float(pitch_str)
                            if pitch_val.is_integer():
                                pitch_key = int(pitch_val)
                            else:
                                pitch_key = pitch_val
                        except ValueError:
                            pitch_key = pitch_str
                        pitch_counter[pitch_key] += 1
                        
                    # Tonal Technique
                    tt = row.get('tonalTechnique', '').strip()
                    if not tt:
                        tt = "None"
                    tonal_technique_counter[tt] += 1
                    
                    # Articulation
                    art = row.get('articulation', '').strip()
                    if not art:
                        art = "None"
                    articulation_counter[art] += 1
                    
                    # Legato
                    legato = row.get('legato', '').strip()
                    if not legato:
                        legato = "None"
                        files_with_none_legato.add(file_path)
                    elif '.' in legato:
                        # Check if it's a float string
                        try:
                            float(legato)
                            files_with_float_legato.add(file_path)
                        except ValueError:
                            pass
                            
                    legato_counter[legato] += 1
                    
        except Exception as e:
            print(f"Error reading {file_path}: {e}")

    print("\n" + "="*30)
    print("       AGGREGATED STATISTICS       ")
    print("="*30)
    
    print(f"\n1. Total Note Count: {total_notes}")
    
    print(f"\n2. Pitch Distribution:")
    # Sort by pitch value
    try:
        sorted_pitches = sorted(pitch_counter.items(), key=lambda x: float(x[0]) if isinstance(x[0], (int, float)) or (isinstance(x[0], str) and x[0].replace('.','',1).isdigit()) else str(x[0]))
    except Exception:
         sorted_pitches = sorted(pitch_counter.items(), key=lambda x: str(x[0]))

    for pitch, count in sorted_pitches:
        print(f"   Pitch {pitch}: {count}")
        
    print(f"\n3. Tonal Technique Distribution:")
    for tt, count in tonal_technique_counter.most_common():
        print(f"   {tt}: {count}")
        
    print(f"\n4. Articulation Distribution:")
    for art, count in articulation_counter.most_common():
        print(f"   {art}: {count}")
        
    print(f"\n5. Legato Distribution:")
    for leg, count in legato_counter.most_common():
        print(f"   {leg}: {count}")
        
    print("\n" + "="*30)
    print("       FILES WITH ISSUES       ")
    print("="*30)
    
    print(f"\nFiles with Floating Point Legato ({len(files_with_float_legato)}):")
    for f in sorted(list(files_with_float_legato)):
        print(f"   {f}")
        
    print(f"\nFiles with None/Empty Legato ({len(files_with_none_legato)}):")
    for f in sorted(list(files_with_none_legato)):
        print(f"   {f}")

if __name__ == "__main__":
    data_directory = "./data"
    if len(sys.argv) > 1:
        data_directory = sys.argv[1]
        
    if os.path.exists(data_directory):
        analyze_annotations(data_directory)
    else:
        print(f"Directory {data_directory} not found.")
