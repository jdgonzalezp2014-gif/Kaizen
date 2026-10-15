-- §165 round 2 (owner, 2026-10-15): a house's furniture has a place of its own, "<record>#house", apart from
-- its closet (the record key, supplies only). Supplies live only in a storage or a closet; furniture moves
-- between the house and a storage. What was recorded for furniture at a house record goes to its house place.
UPDATE inventory_moves m SET place = m.place || '#house'
  FROM inventory_items i, repo_records r
 WHERE i.account_id = m.account_id AND i.id = m.item_id AND i.kind = 'furniture'
   AND r.account_id = m.account_id AND r.table_key || '/' || r.id = m.place
   AND lower(coalesce(r.vals->>'property_type', '')) <> 'storage';

UPDATE inventory_place_mins m SET place = m.place || '#house'
  FROM inventory_items i, repo_records r
 WHERE i.account_id = m.account_id AND i.id = m.item_id AND i.kind = 'furniture'
   AND r.account_id = m.account_id AND r.table_key || '/' || r.id = m.place
   AND lower(coalesce(r.vals->>'property_type', '')) <> 'storage';

UPDATE inventory_place_hidden h SET place = h.place || '#house'
  FROM inventory_items i, repo_records r
 WHERE i.account_id = h.account_id AND i.id = h.item_id AND i.kind = 'furniture'
   AND r.account_id = h.account_id AND r.table_key || '/' || r.id = h.place
   AND lower(coalesce(r.vals->>'property_type', '')) <> 'storage';

-- Order lines (jsonb): a furniture line to a house record goes to the house place.
UPDATE inventory_orders o SET lines = (
  SELECT jsonb_agg(CASE WHEN i.kind = 'furniture' AND r.id IS NOT NULL AND lower(coalesce(r.vals->>'property_type', '')) <> 'storage'
                        THEN jsonb_set(l, '{place}', to_jsonb((l->>'place') || '#house')) ELSE l END ORDER BY n)
    FROM jsonb_array_elements(o.lines) WITH ORDINALITY AS x(l, n)
    LEFT JOIN inventory_items i ON i.account_id = o.account_id AND i.id::text = l->>'itemId'
    LEFT JOIN repo_records r ON r.account_id = o.account_id AND r.table_key || '/' || r.id = l->>'place')
 WHERE jsonb_typeof(o.lines) = 'array' AND jsonb_array_length(o.lines) > 0;
