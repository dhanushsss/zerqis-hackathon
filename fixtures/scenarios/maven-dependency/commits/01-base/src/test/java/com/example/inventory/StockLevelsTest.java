package com.example.inventory;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

class StockLevelsTest {
    private final StockLevels levels = new StockLevels(List.of(
            new InventoryItem("SKU-1", "Filter papers", 40),
            new InventoryItem("SKU-2", "Kettle", 2),
            new InventoryItem("SKU-3", "Scale", 5)));

    @Test
    void findsItemsBelowReorderPoint() {
        assertEquals(2, levels.belowReorderPoint(10).size());
    }

    @Test
    void sumsUnits() {
        assertEquals(47, levels.totalUnits());
    }
}
