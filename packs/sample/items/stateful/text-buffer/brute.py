class TextBuffer:
    def __init__(self):
        self.content = ""

    def insert(self, text):
        self.content = self.content + text

    def delete(self, count):
        for _ in range(count):
            self.content = self.content[:-1]

    def text(self):
        return self.content
