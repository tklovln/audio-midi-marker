#!/usr/bin/env python3
import os
import csv
import sys

def fix_legato_floats(data_dir):
    print(f"Scanning for annotation_revised.csv files in: {data_dir}")
    
    files_modified = 0
    total_files = 0
    
    for root, dirs, files in os.walk(data_dir):
        if "annotation_revised.csv" in files:
            file_path = os.path.join(root, "annotation_revised.csv")
            total_files += 1
            
            rows = []
            needs_update = False
            fieldnames = []
            
            try:
                with open(file_path, 'r', encoding='utf-8', newline='') as f:
                    reader = csv.DictReader(f)
                    fieldnames = reader.fieldnames
                    
                    for row in reader:
                        legato = row.get('legato', '')
                        if legato is None:
                            legato = ''
                        
                        original_legato = legato
                        
                        # Check for float strings like "1.0", "0.0"
                        if '.' in legato:
                            try:
                                val = float(legato)
                                if val.is_integer():
                                    new_legato = str(int(val))
                                    if new_legato != original_legato:
                                        row['legato'] = new_legato
                                        needs_update = True
                            except ValueError:
                                # Not a float, leave as is
                                pass
                        
                        rows.append(row)
                
                if needs_update:
                    print(f"Updating {file_path}...")
                    with open(file_path, 'w', encoding='utf-8', newline='') as f:
                        writer = csv.DictWriter(f, fieldnames=fieldnames)
                        writer.writeheader()
                        writer.writerows(rows)
                    files_modified += 1
                    
            except Exception as e:
                print(f"Error processing {file_path}: {e}")

    print("\n" + "="*30)
    print(f"Processed {total_files} files.")
    print(f"Modified {files_modified} files.")
    print("="*30)

if __name__ == "__main__":
    data_directory = "./data"
    if len(sys.argv) > 1:
        data_directory = sys.argv[1]
        
    if os.path.exists(data_directory):
        fix_legato_floats(data_directory)
    else:
        print(f"Directory {data_directory} not found.")
