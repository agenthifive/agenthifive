/**
 * Recognizer registry — maps pattern type IDs and group aliases to recognizer instances.
 */

import type { Recognizer } from "../types.js";

// Generic
import {
  emailRecognizer, creditCardRecognizer, ibanRecognizer,
  ipAddressRecognizer, urlRecognizer, cryptoWalletRecognizer,
  dateOfBirthRecognizer, macAddressRecognizer, secretCodeRecognizer,
} from "./generic.js";

// Phone (libphonenumber-js)
import { phoneRecognizer } from "./phone.js";

// Country-specific
import {
  usSsnRecognizer, usItinRecognizer, usPassportRecognizer,
  usDriverLicenseRecognizer, usBankRoutingRecognizer, usNpiRecognizer,
} from "./us.js";
import { ukNhsRecognizer, ukNinoRecognizer } from "./uk.js";
import {
  itFiscalCodeRecognizer, itVatRecognizer, itPassportRecognizer,
  itIdentityCardRecognizer, itDriverLicenseRecognizer,
} from "./it.js";
import { inAadhaarRecognizer, inPanRecognizer } from "./in.js";
import { esNifRecognizer, esNieRecognizer } from "./es.js";
import { auTfnRecognizer, auAbnRecognizer } from "./au.js";
import {
  plPeselRecognizer, fiPicRecognizer, thTninRecognizer,
  krRrnRecognizer, sgFinRecognizer,
} from "./other.js";

/** All recognizers by their individual ID. */
const RECOGNIZER_MAP = new Map<string, Recognizer>([
  // Generic
  ["email", emailRecognizer],
  ["credit_card", creditCardRecognizer],
  ["iban", ibanRecognizer],
  ["ip_address", ipAddressRecognizer],
  ["url", urlRecognizer],
  ["crypto_wallet", cryptoWalletRecognizer],
  ["date_of_birth", dateOfBirthRecognizer],
  ["mac_address", macAddressRecognizer],
  ["secret_code", secretCodeRecognizer],
  ["phone", phoneRecognizer],

  // US
  ["us_ssn", usSsnRecognizer],
  ["us_itin", usItinRecognizer],
  ["us_passport", usPassportRecognizer],
  ["us_driver_license", usDriverLicenseRecognizer],
  ["us_bank_routing", usBankRoutingRecognizer],
  ["us_npi", usNpiRecognizer],

  // UK
  ["uk_nhs", ukNhsRecognizer],
  ["uk_nino", ukNinoRecognizer],

  // Italy
  ["it_fiscal_code", itFiscalCodeRecognizer],
  ["it_vat", itVatRecognizer],
  ["it_passport", itPassportRecognizer],
  ["it_identity_card", itIdentityCardRecognizer],
  ["it_driver_license", itDriverLicenseRecognizer],

  // India
  ["in_aadhaar", inAadhaarRecognizer],
  ["in_pan", inPanRecognizer],

  // Spain
  ["es_nif", esNifRecognizer],
  ["es_nie", esNieRecognizer],

  // Australia
  ["au_tfn", auTfnRecognizer],
  ["au_abn", auAbnRecognizer],

  // Other
  ["pl_pesel", plPeselRecognizer],
  ["fi_pic", fiPicRecognizer],
  ["th_tnin", thTninRecognizer],
  ["kr_rrn", krRrnRecognizer],
  ["sg_fin", sgFinRecognizer],
]);

/** Group aliases that expand to multiple recognizer IDs. */
const GROUP_MAP: Record<string, string[]> = {
  all_pii: [...RECOGNIZER_MAP.keys()],

  financial: ["credit_card", "iban", "crypto_wallet", "secret_code"],

  identity: [
    "us_ssn", "us_itin", "us_passport", "us_driver_license", "us_bank_routing", "us_npi",
    "uk_nhs", "uk_nino",
    "it_fiscal_code", "it_vat", "it_passport", "it_identity_card", "it_driver_license",
    "in_aadhaar", "in_pan",
    "es_nif", "es_nie",
    "au_tfn", "au_abn",
    "pl_pesel", "fi_pic", "th_tnin", "kr_rrn", "sg_fin",
    "date_of_birth",
  ],

  contact: ["email", "phone", "ip_address", "mac_address"],
};

/** Legacy aliases for backwards compatibility. */
const LEGACY_ALIASES: Record<string, string> = {
  ssn: "us_ssn",
};

/**
 * Resolve a list of redact pattern types to a deduplicated set of recognizers.
 * Handles individual IDs, group aliases, and legacy aliases.
 */
export function resolveRecognizers(typeIds: string[]): Recognizer[] {
  const seen = new Set<string>();
  const result: Recognizer[] = [];

  for (const id of typeIds) {
    // Check legacy alias
    const resolved = LEGACY_ALIASES[id] ?? id;

    // Check group
    const group = GROUP_MAP[resolved];
    if (group) {
      for (const gid of group) {
        if (seen.has(gid)) continue;
        const rec = RECOGNIZER_MAP.get(gid);
        if (rec) {
          seen.add(gid);
          result.push(rec);
        }
      }
      continue;
    }

    // Individual recognizer
    if (seen.has(resolved)) continue;
    const rec = RECOGNIZER_MAP.get(resolved);
    if (rec) {
      seen.add(resolved);
      result.push(rec);
    }
  }

  return result;
}
