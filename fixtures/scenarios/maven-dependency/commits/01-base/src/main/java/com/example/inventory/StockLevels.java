package com.example.inventory;

import com.google.common.collect.ImmutableList;
import java.util.List;
import java.util.stream.Collectors;

/** Queries over a snapshot of inventory. */
public final class StockLevels {
    private final ImmutableList<InventoryItem> items;

    public StockLevels(List<InventoryItem> items) {
        this.items = ImmutableList.copyOf(items);
    }

    public List<InventoryItem> belowReorderPoint(int reorderPoint) {
        return items.stream()
                .filter(item -> item.quantity() < reorderPoint)
                .collect(Collectors.toList());
    }

    public int totalUnits() {
        return items.stream().mapToInt(InventoryItem::quantity).sum();
    }
}
