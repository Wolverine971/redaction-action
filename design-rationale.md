I focused on making the UX decent. 

To make the review of AI-suggested redactions easy, I have AI scan and suggest redactions, and then group all instances of a redaction entity so that a reviewer can choose to redact or unredact an entity. Cases where you have mixed redactions and unredactions of an entity are a special case, but we track that as well.

We look for entities (people, organizations, addresses, and SSNs) across batches of documents (I assumed all documents would be PDFs). From there, we scan all documents looking for entities, and we group them. We store the location of each reference of an entity by its document, page, block (blocks are text blocks determined by a PDF tool called MuPDF), and then the exact characters.

Once the AI scan is done and all entities are grouped, we display it for the reviewer, and they can choose to redact all or unredact all instances of an entity. If an entity isn't touched, it is by default redacted, and we log 3 different states for each entity:

- AI redacted (the default state).
- Human approved redaction
- Human approved unredaction

Then, once a reviewer is done with a batch of documents, they can export the documents with the redactions, and they can also export the audit log, which tracks the history of decisions to redact or unredact, the entity, who decided, and when.

Here are some things I did not focus on:
- performance of the AI scans across documents (I let the AI design how many loops to do)
- optimizing the accuracy of the entities identified for redaction (AI was doing tests, and it said it was close to 98% accurate and stopped it and said good enough for now, I was using free models on OpenRouter to find entities to redact)
- how the black redaction marks actually get drawn on the PDF: the AI drew bounding boxes, and it looked like it was working, so I left it alone (there might be inefficiencies and better ways to do it)
- identifying all the potential entities that should be redacted, I just went with people, organizations, addresses, and SSNs
- follow-on workflows if another reviewer needs to review the same batch of documents and update the unredactions or unredactions