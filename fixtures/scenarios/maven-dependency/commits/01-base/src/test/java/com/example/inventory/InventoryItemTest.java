package com.example.inventory;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class InventoryItemTest {
    @Test
    void rendersReadableToString() {
        InventoryItem item = new InventoryItem("SKU-42", "Espresso beans", 12);
        assertEquals("InventoryItem{sku=SKU-42, name=Espresso beans, quantity=12}", item.toString());
    }

    @Test
    void rejectsNegativeQuantity() {
        assertThrows(IllegalArgumentException.class, () -> new InventoryItem("SKU-1", "Filter", -1));
    }

    @Test
    void withQuantityReturnsUpdatedCopy() {
        InventoryItem item = new InventoryItem("SKU-7", "Grinder", 3);
        assertEquals(9, item.withQuantity(9).quantity());
        assertEquals(3, item.quantity());
    }
}
