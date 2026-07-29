import os
import glob
import pandas as pd
import numpy as np
import logging

# Configure logging
logging.basicConfig(
    level=logging.WARNING,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("annotation_copy.log"),
        logging.StreamHandler()
    ]
)

def main():
    # Find all annotation.csv files in ./data recursively
    annotation_files = glob.glob('./data/**/annotation.csv', recursive=True)
    
    for annotation_path in annotation_files:
        dir_path = os.path.dirname(annotation_path)
        revised_path = os.path.join(dir_path, 'annotation_revised.csv')
        
        if os.path.exists(revised_path):
            try:
                # Read both CSVs
                df_orig = pd.read_csv(annotation_path)
                df_revised = pd.read_csv(revised_path)
                
                # Check 1: Same number of rows
                if len(df_orig) != len(df_revised):
                    logging.warning(f"[SKIP] Length mismatch for {annotation_path}: Original={len(df_orig)}, Revised={len(df_revised)}")
                    continue
                
                # Check 2: Pitch sequence is identical
                # Handle potential floating point issues if pitch is float, though usually int.
                # Using direct comparison assuming pitch is integer or exact match required.
                # if not df_orig['pitch'].equals(df_revised['pitch']):
                #     logging.warning(f"[SKIP] Pitch sequence mismatch for {annotation_path}")
                #     continue
                
                # Identify columns to copy (all except pitch, start, end)
                # We copy FROM original TO revised
                cols_to_copy = [c for c in df_orig.columns if c not in ['pitch', 'start', 'end']]
                
                if not cols_to_copy:
                    logging.info(f"[INFO] No additional columns to copy for {annotation_path}")
                    continue
                
                # Perform the copy
                df_revised[cols_to_copy] = df_orig[cols_to_copy]
                
                # Save back to annotation_revised.csv
                df_revised.to_csv(revised_path, index=False)
                logging.info(f"[SUCCESS] Updated {revised_path} using data from {annotation_path}")
                
            except Exception as e:
                logging.error(f"[ERROR] Failed processing {annotation_path}: {str(e)}")
        else:
            # logging.info(f"[INFO] No annotation_revised.csv found for {annotation_path}")
            pass

if __name__ == "__main__":
    main()
