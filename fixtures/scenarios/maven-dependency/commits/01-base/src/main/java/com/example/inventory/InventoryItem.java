package com.example.inventory;

import com.google.common.base.Objects;
import com.google.common.base.Preconditions;

/** A stock-keeping unit tracked by the inventory service. */
public final class InventoryItem {
    private final String sku;
    private final String name;
    private final int quantity;

    public InventoryItem(String sku, String name, int quantity) {
        this.sku = Preconditions.checkNotNull(sku, "sku");
        this.name = Preconditions.checkNotNull(name, "name");
        Preconditions.checkArgument(quantity >= 0, "quantity must be non-negative: %s", quantity);
        this.quantity = quantity;
    }

    public String sku() {
        return sku;
    }

    public String name() {
        return name;
    }

    public int quantity() {
        return quantity;
    }

    public InventoryItem withQuantity(int newQuantity) {
        return new InventoryItem(sku, name, newQuantity);
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof InventoryItem)) return false;
        InventoryItem that = (InventoryItem) other;
        return quantity == that.quantity && sku.equals(that.sku) && name.equals(that.name);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(sku, name, quantity);
    }

    @Override
    public String toString() {
        return Objects.toStringHelper(this)
                .add("sku", sku)
                .add("name", name)
                .add("quantity", quantity)
                .toString();
    }
}
