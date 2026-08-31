/**
 * Sanitised fixtures.
 *
 * These are hand-written to match the documented response schema. No real
 * account data is used here or anywhere in the test suite, and no test requires
 * a live YouVersion account or a valid App Key.
 */

/** `GET /v1/highlights?bible_id=3034&passage_id=JHN.3` */
export const CHAPTER_JHN3 = {
  data: [
    { bible_id: 3034, passage_id: "JHN.3.16", color: "44aa44" },
    { bible_id: 3034, passage_id: "JHN.3.17", color: "ffdd00" },
  ],
};

/** Same chapter, one highlight recolored and one removed. */
export const CHAPTER_JHN3_CHANGED = {
  data: [{ bible_id: 3034, passage_id: "JHN.3.16", color: "ff0000" }],
};

/** `GET /v1/bibles/3034/index`, trimmed to two books. */
export const BIBLE_INDEX = {
  text_direction: "ltr",
  books: [
    {
      id: "JHN",
      title: "John",
      canon: "new_testament",
      chapters: [
        { id: "1", passage_id: "JHN.1", title: "1" },
        { id: "2", passage_id: "JHN.2", title: "2" },
        { id: "3", passage_id: "JHN.3", title: "3" },
      ],
    },
    {
      id: "GEN",
      title: "Genesis",
      canon: "old_testament",
      chapters: [{ id: "1", passage_id: "GEN.1", title: "1" }],
    },
  ],
};

/** `GET /v1/bibles/3034` */
export const BIBLE_META = {
  id: 3034,
  abbreviation: "BSB",
  localized_abbreviation: "BSB",
  title: "Berean Standard Bible",
  language_tag: "en",
  copyright: "Berean Standard Bible, dedicated to the public domain.",
};

/** A response that is valid JSON but does not match the documented schema. */
export const CORRUPT_HIGHLIGHTS = { data: [{ bible_id: "not-a-number", passage_id: 42 }] };
