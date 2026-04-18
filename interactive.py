from voyager import Voyager


def main():
    voyager = Voyager()
    try:
        voyager.interactive(reset_env=False)
    finally:
        voyager.close()


if __name__ == "__main__":
    main()
