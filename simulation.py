#!/usr/bin/env python3

import ccxt
import time

def main():
    # 1) Konfigurácia
    leverage = 10.0
    used_margin = 1000.0   # koľko USDT „vkladáme“ do každého obchodu
    max_loss = 50.0        # StopLoss (USDT)
    target_profit = 100.0  # TakeProfit (USDT)

    # 2) Zoznam párov, ktoré chceš sledovať (a „nakúpiť“)
    pairs = [
        "OM/USDT",
        "JUP/USDT",
        "SKL/USDT",
        "SPELL/USDT",
        "PENGU/USDT",
        "TAO/USDT",
        "BEL/USDT",
        "DF/USDT",
        "HIVE/USDT",
        "OP/USDT"
    ]

    exchange = ccxt.binance()  # alebo iná burza z ccxt

    # 3) Vytvor objekt open_positions, kde pre každý symbol uložíme vstupnú cenu, veľkosť pozície a PnL
    open_positions = {}

    # Na začiatku fetchneme všetky tickery naraz (efektívnejšie, než po jednom)
    tickers = exchange.fetch_tickers()

    # Pre každý symbol sa pokúsime zistiť aktuálnu cenu (last) a nakúpiť
    for symbol in pairs:
        # Ak má Binance ticker pre daný pár a existuje 'last' cena:
        if symbol in tickers and tickers[symbol]['last'] is not None:
            current_price = tickers[symbol]['last']
            # Vypočítame veľkosť pozície (notional / current_price)
            notional_value = used_margin * leverage
            if current_price <= 0:
                print(f"{symbol} má neplatnú cenu ({current_price}), preskakujem.")
                continue

            position_size = notional_value / current_price

            # Zapíšeme do open_positions
            open_positions[symbol] = {
                "entry_price": current_price,
                "position_size": position_size,
                "open": True,        # signalizuje, že obchod je aktívny
                "current_pnl": 0.0   # sem budeme ukladať výpočet priebežného PnL
            }

            print(f"Otváram simulovanú pozíciu pre {symbol} pri cene {current_price:.4f}, "
                  f"veľkosť: {position_size:.4f} (margin={used_margin}, páka={leverage}x)")
        else:
            print(f"{symbol} nie je k dispozícii alebo nemá 'last' cenu, preskakujem.")

    # Ak sa nepodarilo otvoriť žiadnu pozíciu, skript skončí
    if not open_positions:
        print("Neboli otvorené žiadne pozície. Končím.")
        return

    print("────────────────────────────────────────────")
    print("Simulované pozície otvorené. Začínam sledovať vývoj...")

    # 4) Hlavná slučka – sledujeme všetky otvorené pozície, až kým sa nezatvoria
    while any(pos["open"] for pos in open_positions.values()):
        try:
            # Načítame najnovšie ceny pre všetky symboly
            all_tickers = exchange.fetch_tickers()

            # Prebehneme všetky otvorené pozície
            for symbol, pos in open_positions.items():
                if not pos["open"]:
                    continue  # pozícia už je uzavretá

                if symbol not in all_tickers or all_tickers[symbol]["last"] is None:
                    print(f"{symbol}: chýba aktuálna cena. Preskakujem výpočet.")
                    continue

                current_price = all_tickers[symbol]["last"]
                entry_price = pos["entry_price"]
                position_size = pos["position_size"]

                # Výpočet nerealizovaného PnL (LONG)
                unrealized_pnl = (current_price - entry_price) * position_size
                pos["current_pnl"] = unrealized_pnl

                # Kontrola Stop Loss / Take Profit
                if unrealized_pnl <= -max_loss:
                    print(f"[{symbol}] STOP LOSS: PnL = {unrealized_pnl:.2f} USDT | Cena: {current_price:.4f}")
                    pos["open"] = False

                elif unrealized_pnl >= target_profit:
                    print(f"[{symbol}] TAKE PROFIT: PnL = +{unrealized_pnl:.2f} USDT | Cena: {current_price:.4f}")
                    pos["open"] = False

                else:
                    # Priebežná informácia
                    print(f"[{symbol}] Cena: {current_price:.4f} | PnL: {unrealized_pnl:.2f} USDT")

            print("────────────────────────────────────────────")
            # Počkáme 10 sekúnd a potom znova zistíme ceny
            time.sleep(10)

        except Exception as e:
            print("Vyskytla sa chyba:", str(e))
            time.sleep(5)
            continue

    print("\nVšetky simulované pozície sú uzavreté. Koniec obchodovania (simulácia).")

if __name__ == "__main__":
    main()
